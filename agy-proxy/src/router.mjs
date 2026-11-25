import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_IDE_USER_AGENT,
} from "./constants.mjs";
import {
  listAccounts,
  getSettings,
  updateAccount,
  isModelLocked,
  getModelLockKey,
  getEarliestLockUntil,
  clearAccountLocks,
} from "./store.mjs";
import { ensureFreshToken, loadAndOnboardProject } from "./oauth.mjs";
import {
  isAccountQuotaExhaustedInCache,
  handleQuotaErrorAndResolveReset,
  clearAccountStrikes,
} from "./quota.mjs";
import {
  normalizeRequestedModel,
  buildAntigravityEnvelope,
  isAntigravityPromptRejection,
  moveSystemInstructionToContents,
  antigravityToOpenAIJson,
  createAntigravityToOpenAISSEStream,
} from "./translator.mjs";

const BACKOFF_STEPS_MS = [10_000, 30_000, 60_000, 180_000, 300_000];

// Mutex to prevent concurrent requests from racing on round-robin / account state
let pickMutex = Promise.resolve();

function formatHumanDuration(isoTimestamp) {
  if (!isoTimestamp) return "";
  const diffMs = new Date(isoTimestamp).getTime() - Date.now();
  if (diffMs <= 0) return "0s";
  const sec = Math.ceil(diffMs / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Parse reset timestamp from Antigravity 429/409 error body or headers
 */
export function parseUpstreamResetMs(response, bodyText) {
  // 1. JSON ErrorInfo / RetryInfo
  if (bodyText) {
    try {
      const json = JSON.parse(bodyText);
      const err = json?.error;
      const details = Array.isArray(err?.details) ? err.details : [];
      for (const d of details) {
        if (d?.metadata?.quotaResetTimeStamp) {
          const ms = new Date(d.metadata.quotaResetTimeStamp).getTime();
          if (!isNaN(ms) && ms > Date.now()) return ms;
        }
        if (typeof d?.retryDelay === "string") {
          const sec = parseFloat(d.retryDelay);
          if (!isNaN(sec) && sec > 0) return Date.now() + Math.round(sec * 1000);
        }
      }
      // 2. Text pattern: "reset after 2h7m23s" or "Resets in 1h56m"
      const msg = String(err?.message || bodyText);
      const m = msg.match(/(?:reset after|resets in)\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
      if (m && (m[1] || m[2] || m[3])) {
        let total = 0;
        if (m[1]) total += parseInt(m[1], 10) * 3_600_000;
        if (m[2]) total += parseInt(m[2], 10) * 60_000;
        if (m[3]) total += parseInt(m[3], 10) * 1_000;
        if (total > 0) return Date.now() + total;
      }
    } catch {}
  }

  // 3. HTTP Retry-After header
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (!isNaN(sec) && sec > 0) return Date.now() + sec * 1000;
    const dt = new Date(retryAfter).getTime();
    if (!isNaN(dt) && dt > Date.now()) return dt;
  }
  return null;
}

function extractReadableError(bodyText, status) {
  if (!bodyText) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText);
    const msg = parsed?.error?.message || parsed?.message || bodyText;
    return typeof msg === "string" ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300);
  } catch {
    return String(bodyText).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }
}

/**
 * Decide whether an error is account/quota-related (should fallback to next account)
 * vs request-scoped (bad client input -> return immediately without locking account).
 */
function classifyUpstreamFailure(status, bodyText) {
  if (isAntigravityPromptRejection(status, bodyText)) {
    return { shouldFallback: false, reason: "prompt_rejection" };
  }
  // 429 (Quota / Rate limit), 409 (Pool exhausted), 401/403 (Token revoked/expired), 402, 5xx
  if (status === 429 || status === 409 || status === 401 || status === 402 || status === 403 || status >= 500) {
    return { shouldFallback: true, reason: `http_${status}` };
  }
  const lower = String(bodyText || "").toLowerCase();
  if (
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("capacity")
  ) {
    return { shouldFallback: true, reason: "quota_text" };
  }
  if (status >= 400 && status < 500) {
    return { shouldFallback: false, reason: "client_bad_request" };
  }
  return { shouldFallback: true, reason: "transient" };
}

/**
 * Select the next available Antigravity account according to settings.strategy
 * ("fill-first" = TK1 -> TK2 -> TK3, or "round-robin")
 */
export async function selectNextAccount(cleanModel, excludeIds = new Set(), preferredId = null) {
  const prev = pickMutex;
  let release;
  pickMutex = new Promise((r) => {
    release = r;
  });

  try {
    await prev;
    const allActive = listAccounts().filter((a) => a.isActive !== false);
    if (allActive.length === 0) {
      return { account: null, reason: "no_accounts", totalActive: 0 };
    }

    const available = allActive.filter((acc) => {
      if (excludeIds.has(acc.id)) return false;
      if (isModelLocked(acc, cleanModel)) return false;
      if (isAccountQuotaExhaustedInCache(acc.id, cleanModel)) return false;
      return true;
    });

    if (available.length === 0) {
      // Find earliest reset time across all active accounts
      const resetCandidates = [];
      for (const acc of allActive) {
        const lockIso = getEarliestLockUntil(acc, cleanModel);
        if (lockIso) resetCandidates.push(lockIso);
        const cacheIso = isAccountQuotaExhaustedInCache(acc.id, cleanModel);
        if (cacheIso) resetCandidates.push(cacheIso);
      }
      resetCandidates.sort();
      return {
        account: null,
        reason: "all_exhausted",
        totalActive: allActive.length,
        earliestResetAt: resetCandidates[0] || null,
        retryAfterHuman: resetCandidates[0] ? formatHumanDuration(resetCandidates[0]) : null,
      };
    }

    if (preferredId) {
      const pinned = available.find((a) => a.id === preferredId || a.email === preferredId);
      if (pinned) return { account: pinned, totalActive: allActive.length };
    }

    const settings = getSettings();
    if (settings.strategy === "round-robin" && available.length > 1) {
      const stickyLimit = settings.stickyRoundRobinLimit || 1;
      const byRecent = [...available].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });
      const cur = byRecent[0];
      if (cur?.lastUsedAt && (cur.consecutiveUseCount || 0) < stickyLimit) {
        await updateAccount(cur.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (cur.consecutiveUseCount || 0) + 1,
        });
        return { account: cur, totalActive: allActive.length };
      }

      const byOldest = [...available].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return -1;
        if (!b.lastUsedAt) return 1;
        return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
      });
      const chosen = byOldest[0];
      await updateAccount(chosen.id, {
        lastUsedAt: new Date().toISOString(),
        consecutiveUseCount: 1,
      });
      return { account: chosen, totalActive: allActive.length };
    }

    // Default: "fill-first" — always use Account #1 until its quota runs out, then Account #2, etc.
    return { account: available[0], totalActive: allActive.length };
  } finally {
    release();
  }
}

async function callAntigravityUpstream(envelope, accessToken, stream, signal) {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${ANTIGRAVITY_BASE_URL}/v1internal:${action}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    ...(stream ? { Accept: "text/event-stream" } : {}),
  };

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    signal,
  });
}

/**
 * Join continuation hops for Gemini 4 Hydrogen non-streaming requests (>64K tokens)
 */
async function resolveNonStreamingWithContinuation(firstRes, envelope, accessToken, signal) {
  const firstJson = await firstRes.json();
  const unwrap = (o) => (o && !o.candidates && o.response ? o.response : o);
  const first = unwrap(firstJson);
  let cand = first?.candidates?.[0];
  let token = cand?.finishReason === "CONTINUATION" ? cand?.continuationToken || first?.continuationToken : null;
  if (!token) return firstJson;

  const allParts = [...(cand?.content?.parts || [])];
  let lastResp = first;
  let hops = 1;
  while (token && hops < 16) {
    const hopEnvelope = {
      ...envelope,
      request: { ...envelope.request, continuationToken: token },
    };
    const nextRes = await callAntigravityUpstream(hopEnvelope, accessToken, false, signal);
    if (!nextRes.ok) break;
    const nextJson = await nextRes.json().catch(() => null);
    if (!nextJson) break;
    const next = unwrap(nextJson);
    hops++;
    cand = next?.candidates?.[0];
    allParts.push(...(cand?.content?.parts || []));
    lastResp = next;
    token = cand?.finishReason === "CONTINUATION" ? cand?.continuationToken || next?.continuationToken : null;
  }

  const finalCand = {
    ...(lastResp?.candidates?.[0] || {}),
    content: { role: "model", parts: allParts },
  };
  if (finalCand.finishReason === "CONTINUATION") finalCand.finishReason = "MAX_TOKENS";
  return { ...firstJson, response: { ...lastResp, candidates: [finalCand] } };
}

/**
 * Core Multi-Account Router Entry
 * Returns { status, headers, isStream, stream?, json? }
 */
export async function routeChatCompletion(body, { preferredAccountId = null, sessionHint = "", signal = undefined } = {}) {
  const settings = getSettings();
  const modelMeta = normalizeRequestedModel(body.model, settings.defaultModel);
  const stream = body.stream === true && !modelMeta.isImage;

  const excludeIds = new Set();
  const attemptTrail = [];
  let lastErrorMsg = null;
  let lastStatus = 503;

  while (true) {
    const picked = await selectNextAccount(modelMeta.cleanModel, excludeIds, preferredAccountId);

    if (!picked.account) {
      if (picked.reason === "no_accounts") {
        return {
          status: 404,
          isStream: false,
          headers: {},
          json: {
            error: {
              message:
                "Chưa có tài khoản Antigravity nào đang bật. Hãy mở giao diện Web hoặc chạy `node cli.mjs login` để đăng nhập OAuth.",
              type: "no_active_accounts",
            },
          },
        };
      }

      const retryHint = picked.retryAfterHuman ? ` (dự kiến mở lại sau ${picked.retryAfterHuman})` : "";
      const retrySec = picked.earliestResetAt
        ? Math.max(1, Math.ceil((new Date(picked.earliestResetAt).getTime() - Date.now()) / 1000))
        : 60;

      return {
        status: 429,
        isStream: false,
        headers: { "Retry-After": String(retrySec) },
        json: {
          error: {
            message: `Tất cả ${picked.totalActive} tài khoản Antigravity đều đã hết quota hoặc đang cooldown cho model "${modelMeta.requestedId}"${retryHint}. Lỗi cuối: ${lastErrorMsg || "Quota exhausted"}`,
            type: "all_accounts_exhausted",
            reset_at: picked.earliestResetAt,
            attempts: attemptTrail,
          },
        },
      };
    }

    let account = picked.account;
    const accLabel = `TK#${account.priority} (${account.email || account.name})`;

    // 1. Refresh OAuth token proactively if expiring within 5m
    try {
      account = await ensureFreshToken(account, { force: false });
    } catch (refreshErr) {
      console.warn(`[Router] ⚠ ${accLabel} lỗi refresh token: ${refreshErr.message} -> chuyển TK tiếp theo`);
      await updateAccount(account.id, {
        [getModelLockKey(null)]: new Date(Date.now() + 5 * 60_000).toISOString(),
        status: "error",
        lastError: refreshErr.message,
        errorCode: 401,
        totalFallbacksFrom: (account.totalFallbacksFrom || 0) + 1,
      });
      attemptTrail.push({ account: account.email || account.id, status: 401, reason: "token_refresh_failed" });
      excludeIds.add(account.id);
      lastErrorMsg = refreshErr.message;
      lastStatus = 401;
      continue;
    }

    // 2. Ensure projectId exists (cold-start discovery)
    if (!account.projectId && account.accessToken) {
      const loaded = await loadAndOnboardProject(account.accessToken, false);
      if (loaded.projectId) {
        account = (await updateAccount(account.id, { projectId: loaded.projectId, tierId: loaded.tierId })) || {
          ...account,
          projectId: loaded.projectId,
        };
      }
    }

    // 3. Translate OpenAI body -> Antigravity envelope
    const { envelope, toolNameMap } = await buildAntigravityEnvelope(body, modelMeta, account, { sessionHint });

    // 4. Execute upstream call (with 1x 401 token-refresh retry & 1x prompt-rejection move retry)
    let upstreamRes;
    let networkErr = null;
    try {
      upstreamRes = await callAntigravityUpstream(envelope, account.accessToken, stream, signal);

      // Retry once on 401/403 with forced token refresh
      if ((upstreamRes.status === 401 || upstreamRes.status === 403) && account.refreshToken) {
        account = await ensureFreshToken(account, { force: true });
        upstreamRes = await callAntigravityUpstream(envelope, account.accessToken, stream, signal);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      networkErr = err;
    }

    // Network/socket error -> lock briefly and fallback to next account
    if (networkErr) {
      const errMsg = networkErr.message || "Network error";
      console.warn(`[Router] ⇄ ${accLabel} lỗi mạng (${errMsg}) -> Fallback sang tài khoản tiếp theo`);
      await updateAccount(account.id, {
        [getModelLockKey(modelMeta.cleanModel)]: new Date(Date.now() + 15_000).toISOString(),
        lastError: errMsg,
        errorCode: 502,
        totalFallbacksFrom: (account.totalFallbacksFrom || 0) + 1,
      });
      attemptTrail.push({ account: account.email || account.id, status: 502, reason: errMsg });
      excludeIds.add(account.id);
      lastErrorMsg = errMsg;
      lastStatus = 502;
      continue;
    }

    // Check for prompt-rejection 429 (move systemInstruction to first user turn once)
    let errorBodyText = null;
    if (upstreamRes.status === 429 && !modelMeta.isImage) {
      errorBodyText = await upstreamRes.text().catch(() => "");
      if (isAntigravityPromptRejection(429, errorBodyText)) {
        const movedEnvelope = moveSystemInstructionToContents(envelope);
        if (movedEnvelope) {
          console.info(`[Router] ↻ ${accLabel} phát hiện system prompt bị chặn mẫu -> thử chuyển vào user turn...`);
          try {
            const retryRes = await callAntigravityUpstream(movedEnvelope, account.accessToken, stream, signal);
            if (retryRes.ok) {
              upstreamRes = retryRes;
              errorBodyText = null;
            } else {
              upstreamRes = retryRes;
              errorBodyText = await retryRes.text().catch(() => "");
            }
          } catch (e) {
            errorBodyText = e.message;
          }
        }
      }
    }

    // 5. Success path!
    if (upstreamRes.ok) {
      const contentType = (upstreamRes.headers.get("content-type") || "").toLowerCase();
      if (stream && !contentType.includes("text/event-stream") && !contentType.includes("application/json")) {
        errorBodyText = await upstreamRes.text().catch(() => "Invalid upstream content-type");
      } else {
        // Clear any old locks/strikes & record usage
        clearAccountStrikes(account.id, modelMeta.cleanModel);
        await clearAccountLocks(account.id, modelMeta.cleanModel);
        await updateAccount(account.id, {
          totalRequests: (account.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          status: "active",
        });

        const metaHeaders = {
          "X-AGY-Account-Id": account.id,
          "X-AGY-Account-Email": account.email || account.name,
          "X-AGY-Account-Priority": String(account.priority || 1),
          "X-AGY-Fallback-Count": String(attemptTrail.length),
        };

        if (attemptTrail.length > 0) {
          console.log(
            `[Router] ✓ Fallback thành công sang ${accLabel} cho model ${modelMeta.requestedId} (sau ${attemptTrail.length} TK lỗi/hết quota)`
          );
        }

        if (stream) {
          const sseStream = createAntigravityToOpenAISSEStream(
            upstreamRes.body,
            modelMeta.requestedId,
            toolNameMap
          );
          return {
            status: 200,
            isStream: true,
            headers: metaHeaders,
            stream: sseStream,
            account,
            fallbackCount: attemptTrail.length,
          };
        }

        const rawJson = await resolveNonStreamingWithContinuation(
          upstreamRes,
          envelope,
          account.accessToken,
          signal
        );
        const openAIJson = antigravityToOpenAIJson(rawJson, modelMeta.requestedId, toolNameMap);
        return {
          status: 200,
          isStream: false,
          headers: metaHeaders,
          json: openAIJson,
          account,
          fallbackCount: attemptTrail.length,
        };
      }
    }

    // 6. Failure path -> inspect error, decide whether to fallback to Account #2
    const status = upstreamRes.status || 502;
    if (errorBodyText === null) {
      errorBodyText = await upstreamRes.text().catch(() => "");
    }
    const readableErr = extractReadableError(errorBodyText, status);
    const decision = classifyUpstreamFailure(status, errorBodyText);

    if (!decision.shouldFallback) {
      // Client's own request error (400 invalid argument / prompt rejection) -> do NOT lock healthy account
      return {
        status: decision.reason === "prompt_rejection" ? 400 : status,
        isStream: false,
        headers: { "X-AGY-Account-Id": account.id },
        json: {
          error: {
            message:
              decision.reason === "prompt_rejection"
                ? "Antigravity từ chối nội dung system prompt này (không phải hết quota tài khoản)."
                : readableErr,
            type: decision.reason,
          },
        },
      };
    }

    // Account/Quota error -> determine exact cooldown & switch immediately to next account!
    let resetMs = parseUpstreamResetMs(upstreamRes, errorBodyText);
    if (status === 429 || status === 409) {
      const liveResetMs = await handleQuotaErrorAndResolveReset(
        account.id,
        status,
        modelMeta.cleanModel,
        account.accessToken,
        account.projectId
      );
      if (liveResetMs && (!resetMs || liveResetMs > resetMs)) {
        resetMs = liveResetMs;
      }
    }

    const nextBackoff = Math.min((account.backoffLevel || 0) + 1, BACKOFF_STEPS_MS.length);
    const defaultCooldown =
      status === 401 || status === 403
        ? 10 * 60_000
        : BACKOFF_STEPS_MS[nextBackoff - 1] || 30_000;
    const lockUntilMs = resetMs && resetMs > Date.now() ? resetMs : Date.now() + defaultCooldown;
    const lockKey = status === 401 || status === 403 ? getModelLockKey(null) : getModelLockKey(modelMeta.cleanModel);

    await updateAccount(account.id, {
      [lockKey]: new Date(lockUntilMs).toISOString(),
      backoffLevel: resetMs ? 0 : nextBackoff,
      status: "cooldown",
      lastError: readableErr,
      errorCode: status,
      totalFallbacksFrom: (account.totalFallbacksFrom || 0) + 1,
    });

    const lockSec = Math.round((lockUntilMs - Date.now()) / 1000);
    console.warn(
      `[Router] ⇄ ${accLabel} gặp lỗi [${status}] (${readableErr.slice(0, 100)}) -> Khóa ${lockSec}s & tự động fallback sang tài khoản tiếp theo!`
    );

    attemptTrail.push({
      account: account.email || account.name || account.id,
      priority: account.priority,
      status,
      reason: readableErr,
      lockedUntil: new Date(lockUntilMs).toISOString(),
    });
    excludeIds.add(account.id);
    lastErrorMsg = readableErr;
    lastStatus = status;
  }
}
