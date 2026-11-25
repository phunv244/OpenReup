import {
  ANTIGRAVITY_OAUTH,
  ANTIGRAVITY_IDE_USER_AGENT,
  ANTIGRAVITY_IDE_VERSION,
  getClientMetadata,
} from "./constants.mjs";

// In-memory live quota cache: accountId -> quotas map
const quotaCache = new Map();
const lastRefreshAt = new Map();
const inflightRefresh = new Map();

const MIN_REFRESH_INTERVAL_MS = 30_000;

// Strike-based circuit breaker (ported from 9router #3681):
// 3x 429/409 within 60s when quota API still looks >0% or unavailable => block account+model for 15m
const STRIKE_WINDOW_MS = 60_000;
const STRIKE_THRESHOLD = 3;
const STRIKE_BLOCK_MS = 15 * 60_000;
const strikeCounts = new Map(); // "accountId|model" -> { count, windowStart }
const strikeBlocks = new Map(); // "accountId|model" -> blockedUntilMs

const GROUP_CONFIGS = [
  {
    pattern: /argon/i,
    weekly: { key: "gemini_argon_weekly", displayName: "Gemini 4 Argon (Tuần)" },
    session: { key: "gemini_argon_session", displayName: "Gemini 4 Argon (5h)" },
  },
  {
    pattern: /gemini/i,
    weekly: { key: "gemini_weekly", displayName: "Gemini (Tuần)" },
    session: { key: "gemini_session", displayName: "Gemini (5h)" },
  },
  {
    pattern: /claude|gpt/i,
    weekly: { key: "claude_gpt_weekly", displayName: "Claude & GPT (Tuần)" },
    session: { key: "claude_gpt_session", displayName: "Claude & GPT (5h)" },
  },
];

function parseResetTime(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchJsonWithTimeout(url, options, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function parseWeeklyQuotaSummary(data) {
  if (!data || typeof data !== "object") return {};
  const groups = Array.isArray(data.groups)
    ? data.groups
    : Array.isArray(data.quotaSummary?.groups)
      ? data.quotaSummary.groups
      : null;
  if (!groups) return {};

  const result = {};
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const displayName = group.displayName || "";
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];

    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const windowType = String(bucket.window || "").toLowerCase();
      const bucketText = `${bucket.bucketId || ""} ${bucket.displayName || ""}`.toLowerCase();
      const isWeekly = windowType === "weekly" || bucketText.includes("weekly");
      const isSession =
        windowType === "5h" ||
        windowType === "daily" ||
        bucketText.includes("five hour") ||
        bucketText.includes("5h") ||
        bucketText.includes("daily");
      if (!isWeekly && !isSession) continue;
      if (bucket.disabled === true && isWeekly) continue;

      const remainingFraction = bucket.disabled === true ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction)) continue;

      for (const cfg of GROUP_CONFIGS) {
        if (cfg.pattern.test(displayName)) {
          const target = isWeekly ? cfg.weekly : cfg.session;
          if (result[target.key]) break;
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          result[target.key] = {
            used: Math.max(0, total - remaining),
            total,
            resetAt: parseResetTime(bucket.resetTime),
            remainingPercentage: Math.round(remainingFraction * 1000) / 10,
            displayName: target.displayName,
          };
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Fetch live quota (per-model + 5h/weekly summary) from Antigravity API
 */
export async function fetchLiveAntigravityQuota(accessToken, projectId = "") {
  let resolvedProject = projectId;
  let paidTierId = null;
  let planName = "Free";

  try {
    const subRes = await fetchJsonWithTimeout(ANTIGRAVITY_OAUTH.loadCodeAssistEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
      },
      body: JSON.stringify({ metadata: getClientMetadata() }),
    });
    if (subRes.ok) {
      const subData = await subRes.json();
      const p = subData.cloudaicompanionProject;
      if (!resolvedProject && p) {
        resolvedProject = typeof p === "object" ? p.id || "" : String(p);
      }
      paidTierId = subData.paidTier?.id || null;
      planName = subData.paidTier?.name || subData.currentTier?.name || (paidTierId ? paidTierId : "Free");
    }
  } catch {}

  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    "Content-Type": "application/json",
    "X-Client-Name": "antigravity",
    "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
  };
  const bodyPayload = JSON.stringify(resolvedProject ? { project: resolvedProject } : {});

  const [modelsRes, summaryRes] = await Promise.allSettled([
    fetchJsonWithTimeout(ANTIGRAVITY_OAUTH.quotaApiUrl, {
      method: "POST",
      headers: commonHeaders,
      body: bodyPayload,
    }),
    fetchJsonWithTimeout(ANTIGRAVITY_OAUTH.quotaSummaryApiUrl, {
      method: "POST",
      headers: commonHeaders,
      body: bodyPayload,
    }),
  ]);

  const quotas = {};
  const isFreeTier = !paidTierId || paidTierId === "free-tier";
  const discoveredModels = [];

  if (modelsRes.status === "fulfilled" && modelsRes.value.ok) {
    const data = await modelsRes.value.json().catch(() => ({}));
    if (data.models && typeof data.models === "object") {
      for (const [modelKey, info] of Object.entries(data.models)) {
        if (!info?.isInternal) {
          discoveredModels.push({ id: modelKey, name: info?.displayName || modelKey });
        }
        if (!isFreeTier && info?.quotaInfo && !info.isInternal) {
          const frac = Number(info.quotaInfo.remainingFraction ?? 0);
          const total = 1000;
          const remaining = Math.round(total * frac);
          quotas[modelKey] = {
            used: total - remaining,
            total,
            resetAt: parseResetTime(info.quotaInfo.resetTime),
            remainingPercentage: Math.round(frac * 1000) / 10,
            displayName: info.displayName || modelKey,
          };
        }
      }
    }
  }

  if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
    const sumData = await summaryRes.value.json().catch(() => ({}));
    Object.assign(quotas, parseWeeklyQuotaSummary(sumData));
  }

  return { plan: planName, projectId: resolvedProject, quotas, discoveredModels };
}

function applyActiveStrikeBlocks(accountId, quotas) {
  const now = Date.now();
  const out = { ...(quotas || {}) };
  for (const [key, until] of strikeBlocks) {
    if (!key.startsWith(`${accountId}|`)) continue;
    if (until <= now) {
      strikeBlocks.delete(key);
      continue;
    }
    const model = key.slice(accountId.length + 1);
    out[model] = {
      remainingPercentage: 0,
      resetAt: new Date(until).toISOString(),
      strikeBlocked: true,
    };
  }
  return out;
}

export function getAntigravityModelFamily(model) {
  if (!model || typeof model !== "string") return null;
  const clean = (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model).toLowerCase();
  if (clean.startsWith("claude-") || clean.startsWith("gpt-") || clean === "claude") {
    return "claude_gpt";
  }
  if ((clean.startsWith("gemini-") && clean.includes("argon")) || clean === "gemini_argon") {
    return "gemini_argon";
  }
  if ((clean.startsWith("gemini-") && !clean.includes("image")) || clean === "gemini") {
    return "gemini";
  }
  return null;
}

export function getAntigravityModelQuota(quotas, model) {
  if (!quotas || typeof quotas !== "object" || !model) return null;
  const cleanModel = String(model.includes("/") ? model.slice(model.indexOf("/") + 1) : model)
    .replace(/\([^()]+\)\s*$/, "")
    .trim();

  const family = getAntigravityModelFamily(cleanModel);
  const candidates = [];

  if (quotas[cleanModel]) candidates.push(quotas[cleanModel]);

  const aliasMap = {
    "gemini-4-carbon": "gemini-4-carbon-high",
    "gemini-4-argon": "gemini-4-argon-high",
    "gemini-4-neon": "gemini-4-neon-high",
    "gemini-4-hydrogen": "gemini-4-hydrogen-high",
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.7-flash": "gemini-3.7-flash-medium",
    "gemini-3.6-flash": "gemini-3.6-flash-medium",
  };
  if (aliasMap[cleanModel] && quotas[aliasMap[cleanModel]]) {
    candidates.push(quotas[aliasMap[cleanModel]]);
  }
  if (cleanModel === "claude-sonnet-5-5" && (quotas["claude-sonnet-5-5-medium"] || quotas["claude-sonnet-5-5-high"])) {
    candidates.push(quotas["claude-sonnet-5-5-medium"] || quotas["claude-sonnet-5-5-high"]);
  }
  if (cleanModel === "claude-opus-5-5" && (quotas["claude-opus-5-5-medium"] || quotas["claude-opus-5-5-high"])) {
    candidates.push(quotas["claude-opus-5-5-medium"] || quotas["claude-opus-5-5-high"]);
  }

  if (family === "claude_gpt") {
    if (quotas.claude_gpt_session) candidates.push(quotas.claude_gpt_session);
    if (quotas.claude_gpt_weekly) candidates.push(quotas.claude_gpt_weekly);
  } else if (family === "gemini_argon") {
    if (quotas.gemini_argon_session) candidates.push(quotas.gemini_argon_session);
    if (quotas.gemini_argon_weekly) candidates.push(quotas.gemini_argon_weekly);
    if (!quotas.gemini_argon_session && !quotas.gemini_argon_weekly) {
      if (quotas.gemini_session) candidates.push(quotas.gemini_session);
      if (quotas.gemini_weekly) candidates.push(quotas.gemini_weekly);
    }
  } else if (family === "gemini") {
    if (quotas.gemini_session) candidates.push(quotas.gemini_session);
    if (quotas.gemini_weekly) candidates.push(quotas.gemini_weekly);
  }

  if (candidates.length === 0) return null;

  const now = Date.now();
  const exhausted = [];
  for (const c of candidates) {
    if (c && typeof c.remainingPercentage === "number" && c.remainingPercentage <= 0) {
      const resetMs = c.resetAt ? new Date(c.resetAt).getTime() : 0;
      if (!c.resetAt || resetMs > now) {
        exhausted.push({ ...c, resetMs });
      }
    }
  }

  if (exhausted.length > 0) {
    exhausted.sort((a, b) => b.resetMs - a.resetMs);
    return {
      remainingPercentage: 0,
      resetAt: exhausted[0].resetAt,
      displayName: exhausted[0].displayName || cleanModel,
    };
  }

  const valid = candidates.filter((c) => c && typeof c.remainingPercentage === "number");
  if (!valid.length) return null;
  valid.sort((a, b) => a.remainingPercentage - b.remainingPercentage);
  return valid[0];
}

export function getCachedAccountQuotas(accountId) {
  return quotaCache.get(accountId) || null;
}

export function isAccountQuotaExhaustedInCache(accountId, model) {
  if (!accountId || !model) return null;
  const quotas = quotaCache.get(accountId);
  if (!quotas) return null;
  const q = getAntigravityModelQuota(quotas, model) || quotas[model];
  if (q && q.remainingPercentage <= 0 && q.resetAt && new Date(q.resetAt).getTime() > Date.now()) {
    return q.resetAt;
  }
  return null;
}

export async function refreshAccountQuota(accountId, accessToken, projectId = "", { force = false } = {}) {
  const now = Date.now();
  if (inflightRefresh.has(accountId)) return inflightRefresh.get(accountId);

  const last = lastRefreshAt.get(accountId) || 0;
  if (!force && now - last < MIN_REFRESH_INTERVAL_MS && quotaCache.has(accountId)) {
    return { quotas: quotaCache.get(accountId), cached: true };
  }

  lastRefreshAt.set(accountId, now);
  const promise = (async () => {
    try {
      const res = await fetchLiveAntigravityQuota(accessToken, projectId);
      const merged = applyActiveStrikeBlocks(accountId, res.quotas);
      quotaCache.set(accountId, merged);
      return { ...res, quotas: merged, cached: false };
    } catch (err) {
      return { error: err.message, quotas: quotaCache.get(accountId) || null };
    }
  })();

  inflightRefresh.set(accountId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(accountId);
  }
}

export function clearAccountQuotaCache(accountId) {
  quotaCache.delete(accountId);
  lastRefreshAt.delete(accountId);
  for (const key of strikeCounts.keys()) {
    if (key.startsWith(`${accountId}|`)) strikeCounts.delete(key);
  }
  for (const key of strikeBlocks.keys()) {
    if (key.startsWith(`${accountId}|`)) strikeBlocks.delete(key);
  }
}

export function clearAccountStrikes(accountId, model) {
  const key = `${accountId}|${model}`;
  strikeCounts.delete(key);
  const until = strikeBlocks.get(key);
  if (until === undefined) return;
  strikeBlocks.delete(key);
  const cached = quotaCache.get(accountId);
  const iso = new Date(until).toISOString();
  if (cached?.[model]?.resetAt === iso) {
    delete cached[model];
    quotaCache.set(accountId, cached);
  }
}

export async function handleQuotaErrorAndResolveReset(accountId, status, model, accessToken, projectId = "") {
  const { quotas } = await refreshAccountQuota(accountId, accessToken, projectId, { force: false });
  const q = getAntigravityModelQuota(quotas, model);

  if (!q || q.remainingPercentage > 0) {
    const key = `${accountId}|${model}`;
    const now = Date.now();
    const prev = strikeCounts.get(key);
    const windowStart = prev && now - prev.windowStart <= STRIKE_WINDOW_MS ? prev.windowStart : now;
    const count = prev && windowStart === prev.windowStart ? prev.count + 1 : 1;
    strikeCounts.set(key, { count, windowStart });
    if (count >= STRIKE_THRESHOLD) {
      strikeCounts.delete(key);
      const blockedUntil = now + STRIKE_BLOCK_MS;
      const cached = quotaCache.get(accountId) || {};
      cached[model] = { remainingPercentage: 0, resetAt: new Date(blockedUntil).toISOString(), strikeBlocked: true };
      quotaCache.set(accountId, cached);
      strikeBlocks.set(key, blockedUntil);
      return blockedUntil;
    }
    return null;
  }

  strikeCounts.delete(`${accountId}|${model}`);
  if (!q.resetAt) return null;
  const resetMs = new Date(q.resetAt).getTime();
  if (resetMs <= Date.now()) return null;

  const cached = quotaCache.get(accountId) || {};
  cached[model] = { remainingPercentage: 0, resetAt: q.resetAt };
  quotaCache.set(accountId, cached);
  return resetMs;
}
