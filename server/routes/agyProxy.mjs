/**
 * Tích hợp AGY Multi-Account Proxy trực tiếp vào Fastify server của OpenReup Studio.
 * - Gateway chung chuẩn OpenAI: /v1/models, /v1/chat/completions (JSON + SSE), /v1/ask
 * - API quản trị cho giao diện web: /api/agy-proxy/*
 * Dùng chung kho tài khoản agy-proxy/data/accounts.json với CLI (`npm run agy:login`).
 */
import { Readable } from "node:stream";
import { ANTIGRAVITY_MODELS } from "../../agy-proxy/src/constants.mjs";
import {
  listAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  reorderAccounts,
  clearAccountLocks,
  maskAccountForApi,
  getSettings,
  updateSettings,
} from "../../agy-proxy/src/store.mjs";
import {
  startOAuthSession,
  getOAuthSessionStatus,
  completeOAuthSessionManually,
  ensureFreshToken,
} from "../../agy-proxy/src/oauth.mjs";
import {
  getCachedAccountQuotas,
  refreshAccountQuota,
  clearAccountQuotaCache,
} from "../../agy-proxy/src/quota.mjs";
import { routeChatCompletion } from "../../agy-proxy/src/router.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Expose-Headers":
    "X-AGY-Account-Id, X-AGY-Account-Email, X-AGY-Account-Priority, X-AGY-Fallback-Count, Retry-After",
};

function checkGatewayApiKey(req) {
  const settings = getSettings();
  if (!settings.requireApiKey || !settings.apiKey) return true;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const xKey = String(req.headers["x-api-key"] || "").trim();
  return (bearer || xKey) === settings.apiKey;
}

export default async function agyProxyRoutes(app) {
  // Gia hạn OAuth token chạy nền định kỳ mỗi 15 phút
  const bgTimer = setInterval(async () => {
    const accounts = listAccounts().filter((a) => a.isActive !== false && a.refreshToken);
    for (const acc of accounts) {
      try {
        await ensureFreshToken(acc, { force: false });
      } catch (e) {
        console.warn(`[AGY-BG-Refresh] ${acc.email || acc.id}: ${e.message}`);
      }
    }
  }, 15 * 60 * 1000);
  bgTimer.unref?.();
  app.addHook("onClose", async () => clearInterval(bgTimer));

  // CORS preflight cho /v1/*
  app.options("/v1/*", async (_req, reply) => {
    reply.headers(CORS_HEADERS).code(204).send();
  });

  // ─── 1. OpenAI-Compatible Unified Gateway (/v1/*) ─────────────────────────
  app.get("/v1/models", async (req, reply) => {
    reply.headers(CORS_HEADERS);
    if (!checkGatewayApiKey(req)) {
      return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } });
    }
    const created = Math.floor(Date.now() / 1000);
    return {
      object: "list",
      data: ANTIGRAVITY_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        object: "model",
        created,
        owned_by: "antigravity",
      })),
    };
  });

  app.post("/v1/chat/completions", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    if (!checkGatewayApiKey(req)) {
      return reply
        .headers(CORS_HEADERS)
        .code(401)
        .send({ error: { message: "Invalid or missing API key", type: "authentication_error" } });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const preferredAccountId = req.headers["x-agy-account-id"] || body.account_id || null;
    const sessionHint = String(req.headers["x-session-id"] || "");

    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abortController.abort();
    });

    const result = await routeChatCompletion(body, {
      preferredAccountId,
      sessionHint,
      signal: abortController.signal,
    });

    if (!result.isStream) {
      return reply
        .headers({ ...CORS_HEADERS, ...(result.headers || {}) })
        .code(result.status)
        .send(result.json);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
      ...(result.headers || {}),
    });

    const nodeStream = Readable.fromWeb(result.stream);
    nodeStream.on("error", () => {
      if (!reply.raw.writableEnded) reply.raw.end();
    });
    nodeStream.pipe(reply.raw);
  });

  app.post("/v1/ask", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    reply.headers(CORS_HEADERS);
    if (!checkGatewayApiKey(req)) {
      return reply.code(401).send({ ok: false, error: "Invalid or missing API key" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    if (!messages.length) {
      if (body.system) messages.push({ role: "system", content: String(body.system) });
      if (body.prompt !== undefined) messages.push({ role: "user", content: String(body.prompt) });
    }
    if (!messages.length) {
      return reply.code(400).send({ ok: false, error: "Thiếu `prompt` hoặc `messages` trong body" });
    }

    const openAIBody = {
      model: body.model,
      messages,
      stream: false,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
      ...(body.json === true ? { response_format: { type: "json_object" } } : {}),
    };

    const result = await routeChatCompletion(openAIBody, {
      preferredAccountId: req.headers["x-agy-account-id"] || body.account_id || null,
    });

    if (result.headers) reply.headers(result.headers);
    if (result.status !== 200) {
      return reply.code(result.status).send({
        ok: false,
        error: result.json?.error?.message || "Upstream error",
        details: result.json?.error,
      });
    }

    const choice = result.json?.choices?.[0]?.message || {};
    return {
      ok: true,
      text: choice.content ?? "",
      reasoning: choice.reasoning_content ?? null,
      model: result.json?.model,
      account: result.account
        ? {
            id: result.account.id,
            email: result.account.email || result.account.name,
            priority: result.account.priority,
          }
        : null,
      fallbackCount: result.fallbackCount || 0,
      usage: result.json?.usage || null,
    };
  });

  // ─── 2. Management APIs (/api/agy-proxy/*) ────────────────────────────────
  app.get("/api/agy-proxy/accounts", async () => ({
    ok: true,
    accounts: listAccounts().map((a) => maskAccountForApi(a, getCachedAccountQuotas(a.id))),
  }));

  app.post("/api/agy-proxy/accounts/reorder", async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) return reply.code(400).send({ ok: false, error: "ids phải là mảng" });
    const reordered = await reorderAccounts(ids);
    return {
      ok: true,
      accounts: reordered.map((a) => maskAccountForApi(a, getCachedAccountQuotas(a.id))),
    };
  });

  app.post("/api/agy-proxy/accounts/:id/unlock", async (req, reply) => {
    const id = req.params.id;
    clearAccountQuotaCache(id);
    const updated = await clearAccountLocks(id);
    if (!updated) return reply.code(404).send({ ok: false, error: "Không tìm thấy tài khoản" });
    return { ok: true, account: maskAccountForApi(updated, getCachedAccountQuotas(id)) };
  });

  app.patch("/api/agy-proxy/accounts/:id", async (req, reply) => {
    const id = req.params.id;
    const body = req.body || {};
    const patch = {};
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    const updated = await updateAccount(id, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: "Không tìm thấy tài khoản" });
    return { ok: true, account: maskAccountForApi(updated, getCachedAccountQuotas(id)) };
  });

  app.delete("/api/agy-proxy/accounts/:id", async (req, reply) => {
    const ok = await deleteAccount(req.params.id);
    if (!ok) return reply.code(404).send({ ok: false, error: "Không tìm thấy tài khoản" });
    return { ok: true };
  });

  app.get("/api/agy-proxy/quota", async (req) => {
    const force = req.query?.force === "1";
    const accounts = listAccounts();
    const results = await Promise.all(
      accounts.map(async (acc) => {
        try {
          const fresh = await ensureFreshToken(acc);
          const q = await refreshAccountQuota(acc.id, fresh.accessToken, fresh.projectId, { force });
          if (q.projectId && !fresh.projectId) {
            await updateAccount(acc.id, { projectId: q.projectId });
          }
          return { id: acc.id, email: acc.email, plan: q.plan, quotas: q.quotas, error: q.error || null };
        } catch (e) {
          return { id: acc.id, email: acc.email, error: e.message, quotas: null };
        }
      })
    );
    return { ok: true, results };
  });

  app.get("/api/agy-proxy/quota/:id", async (req, reply) => {
    const acc = getAccountById(req.params.id);
    if (!acc) return reply.code(404).send({ ok: false, error: "Không tìm thấy tài khoản" });
    const force = req.query?.force === "1";
    const fresh = await ensureFreshToken(acc);
    const q = await refreshAccountQuota(acc.id, fresh.accessToken, fresh.projectId, { force });
    if (q.projectId && !fresh.projectId) {
      await updateAccount(acc.id, { projectId: q.projectId });
    }
    return { ok: true, id: acc.id, email: acc.email, plan: q.plan, quotas: q.quotas };
  });

  app.post("/api/agy-proxy/oauth/start", async (req) => {
    const session = await startOAuthSession({ customName: req.body?.name || "" });
    return {
      ok: true,
      state: session.state,
      authUrl: session.authUrl,
      redirectUri: session.redirectUri,
      port: session.port,
    };
  });

  app.get("/api/agy-proxy/oauth/status", async (req) => {
    const state = String(req.query?.state || "");
    return { ok: true, ...getOAuthSessionStatus(state) };
  });

  app.post("/api/agy-proxy/oauth/manual", async (req, reply) => {
    try {
      const account = await completeOAuthSessionManually(req.body?.state, req.body?.callbackUrl || req.body?.code);
      return { ok: true, account: maskAccountForApi(account) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e.message });
    }
  });

  app.get("/api/agy-proxy/settings", async () => ({ ok: true, settings: getSettings() }));

  app.post("/api/agy-proxy/settings", async (req) => {
    const next = await updateSettings(req.body || {});
    return { ok: true, settings: next };
  });
}
