#!/usr/bin/env node
import http from "node:http";
import { Readable } from "node:stream";
import { ANTIGRAVITY_MODELS } from "./src/constants.mjs";
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
} from "./src/store.mjs";
import {
  startOAuthSession,
  getOAuthSessionStatus,
  completeOAuthSessionManually,
  ensureFreshToken,
} from "./src/oauth.mjs";
import { getCachedAccountQuotas, refreshAccountQuota, clearAccountQuotaCache } from "./src/quota.mjs";
import { routeChatCompletion } from "./src/router.mjs";
import { renderDashboardHtml } from "./src/ui.mjs";

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB for base64 vision payloads

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === "--host" && argv[i + 1]) out.host = argv[++i];
  }
  return out;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Expose-Headers":
      "X-AGY-Account-Id, X-AGY-Account-Email, X-AGY-Account-Priority, X-AGY-Fallback-Count, Retry-After",
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function checkGatewayApiKey(req) {
  const settings = getSettings();
  if (!settings.requireApiKey || !settings.apiKey) return true;
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const xKey = req.headers["x-api-key"] || "";
  const provided = bearer || xKey;
  return provided === settings.apiKey;
}

export function createProxyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        });
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      // ─── Dashboard Web UI ────────────────────────────────────────────────
      if (req.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboardHtml());
        return;
      }

      // ─── Health check ────────────────────────────────────────────────────
      if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
        const accounts = listAccounts();
        const active = accounts.filter((a) => a.isActive !== false);
        sendJson(res, 200, {
          ok: true,
          service: "agy-multi-account-proxy",
          totalAccounts: accounts.length,
          activeAccounts: active.length,
          strategy: getSettings().strategy,
          defaultModel: getSettings().defaultModel,
        });
        return;
      }

      // ─── Unified Gateway Endpoints (/v1/*) ───────────────────────────────
      if (pathname === "/api/models") {
        sendJson(res, 200, {
          ok: true,
          data: ANTIGRAVITY_MODELS.map((m) => ({ id: m.id, name: m.name })),
        });
        return;
      }

      if (pathname === "/v1/models" || pathname === "/models") {
        if (!checkGatewayApiKey(req)) {
          sendJson(res, 401, { error: { message: "Invalid or missing API key", type: "authentication_error" } });
          return;
        }
        const created = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
          object: "list",
          data: ANTIGRAVITY_MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            object: "model",
            created,
            owned_by: "antigravity",
          })),
        });
        return;
      }

      if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
        if (!checkGatewayApiKey(req)) {
          sendJson(res, 401, { error: { message: "Invalid or missing API key", type: "authentication_error" } });
          return;
        }
        const body = await readJsonBody(req);
        const preferredAccountId = req.headers["x-agy-account-id"] || body.account_id || null;
        const sessionHint = req.headers["x-session-id"] || "";

        const abortController = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abortController.abort();
        });

        const result = await routeChatCompletion(body, {
          preferredAccountId,
          sessionHint,
          signal: abortController.signal,
        });

        if (!result.isStream) {
          sendJson(res, result.status, result.json, result.headers);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers":
            "X-AGY-Account-Id, X-AGY-Account-Email, X-AGY-Account-Priority, X-AGY-Fallback-Count",
          ...result.headers,
        });

        const nodeStream = Readable.fromWeb(result.stream);
        nodeStream.on("error", () => {
          if (!res.writableEnded) res.end();
        });
        nodeStream.pipe(res);
        return;
      }

      // Simple JSON helper endpoint: POST /v1/ask
      // Body: { prompt, system?, messages?, model?, temperature?, max_tokens?, json? }
      if (req.method === "POST" && (pathname === "/v1/ask" || pathname === "/api/ask")) {
        if (!checkGatewayApiKey(req)) {
          sendJson(res, 401, { ok: false, error: "Invalid or missing API key" });
          return;
        }
        const body = await readJsonBody(req);
        const messages = Array.isArray(body.messages) ? [...body.messages] : [];
        if (!messages.length) {
          if (body.system) messages.push({ role: "system", content: String(body.system) });
          if (body.prompt !== undefined) messages.push({ role: "user", content: String(body.prompt) });
        }
        if (!messages.length) {
          sendJson(res, 400, { ok: false, error: "Missing `prompt` or `messages` in request body" });
          return;
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

        if (result.status !== 200) {
          sendJson(res, result.status, {
            ok: false,
            error: result.json?.error?.message || "Upstream error",
            details: result.json?.error,
          }, result.headers);
          return;
        }

        const choice = result.json?.choices?.[0]?.message || {};
        sendJson(
          res,
          200,
          {
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
          },
          result.headers
        );
        return;
      }

      // ─── Management APIs (Dashboard & CLI) ───────────────────────────────
      if (req.method === "GET" && pathname === "/api/accounts") {
        const accounts = listAccounts().map((a) => maskAccountForApi(a, getCachedAccountQuotas(a.id)));
        sendJson(res, 200, { accounts });
        return;
      }

      if (req.method === "POST" && pathname === "/api/accounts/reorder") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.ids)) {
          sendJson(res, 400, { error: "ids must be an array" });
          return;
        }
        const reordered = await reorderAccounts(body.ids);
        sendJson(res, 200, { accounts: reordered.map((a) => maskAccountForApi(a, getCachedAccountQuotas(a.id))) });
        return;
      }

      const accUnlockMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/unlock$/);
      if (req.method === "POST" && accUnlockMatch) {
        const targetId = decodeURIComponent(accUnlockMatch[1]);
        clearAccountQuotaCache(targetId);
        const updated = await clearAccountLocks(targetId);
        if (!updated) return sendJson(res, 404, { error: "Account not found" });
        sendJson(res, 200, { account: maskAccountForApi(updated, getCachedAccountQuotas(updated.id)) });
        return;
      }

      const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accMatch) {
        const id = decodeURIComponent(accMatch[1]);
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const patch = {};
          if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
          if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
          const updated = await updateAccount(id, patch);
          if (!updated) return sendJson(res, 404, { error: "Account not found" });
          sendJson(res, 200, { account: maskAccountForApi(updated, getCachedAccountQuotas(id)) });
          return;
        }
        if (req.method === "DELETE") {
          const ok = await deleteAccount(id);
          sendJson(res, ok ? 200 : 404, { ok });
          return;
        }
      }

      // Quota endpoints
      if (req.method === "GET" && pathname === "/api/quota") {
        const force = url.searchParams.get("force") === "1";
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
        sendJson(res, 200, { results });
        return;
      }

      const quotaOneMatch = pathname.match(/^\/api\/quota\/([^/]+)$/);
      if (req.method === "GET" && quotaOneMatch) {
        const id = decodeURIComponent(quotaOneMatch[1]);
        const acc = getAccountById(id);
        if (!acc) return sendJson(res, 404, { error: "Account not found" });
        const force = url.searchParams.get("force") === "1";
        const fresh = await ensureFreshToken(acc);
        const q = await refreshAccountQuota(acc.id, fresh.accessToken, fresh.projectId, { force });
        if (q.projectId && !fresh.projectId) {
          await updateAccount(acc.id, { projectId: q.projectId });
        }
        sendJson(res, 200, { id: acc.id, email: acc.email, plan: q.plan, quotas: q.quotas });
        return;
      }

      // OAuth endpoints
      if (req.method === "POST" && pathname === "/api/oauth/start") {
        const body = await readJsonBody(req).catch(() => ({}));
        const session = await startOAuthSession({ customName: body.name || "" });
        sendJson(res, 200, {
          state: session.state,
          authUrl: session.authUrl,
          redirectUri: session.redirectUri,
          port: session.port,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/oauth/status") {
        const state = url.searchParams.get("state") || "";
        sendJson(res, 200, getOAuthSessionStatus(state));
        return;
      }

      if (req.method === "POST" && pathname === "/api/oauth/manual") {
        const body = await readJsonBody(req);
        const account = await completeOAuthSessionManually(body.state, body.callbackUrl || body.code);
        sendJson(res, 200, { ok: true, account: maskAccountForApi(account) });
        return;
      }

      // Settings endpoints
      if (req.method === "GET" && pathname === "/api/settings") {
        sendJson(res, 200, getSettings());
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        const next = await updateSettings(body);
        sendJson(res, 200, next);
        return;
      }

      sendJson(res, 404, { error: { message: `Route not found: ${req.method} ${pathname}` } });
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error("[Server Error]", err);
      if (!res.headersSent) {
        sendJson(res, err.message === "Invalid JSON body" ? 400 : 500, {
          error: { message: err.message || "Internal server error" },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // Periodic background token refresh every 15 minutes so accounts stay ready
  const bgTimer = setInterval(async () => {
    const accounts = listAccounts().filter((a) => a.isActive !== false && a.refreshToken);
    for (const acc of accounts) {
      try {
        await ensureFreshToken(acc, { force: false });
      } catch (e) {
        console.warn(`[BG-Refresh] ${acc.email || acc.id}: ${e.message}`);
      }
    }
  }, 15 * 60 * 1000);
  bgTimer.unref?.();

  server.on("close", () => clearInterval(bgTimer));
  return server;
}

// Run standalone if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliArgs = parseArgs(process.argv.slice(2));
  const port = cliArgs.port || Number(process.env.PORT || 3457);
  const host = cliArgs.host || process.env.HOST || "0.0.0.0";

  const server = createProxyServer();
  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`\n🚀 Antigravity Multi-Account Proxy đã sẵn sàng!`);
    console.log(`   • Giao diện Web & OAuth : http://${displayHost}:${port}`);
    console.log(`   • OpenAI Endpoint chung : http://${displayHost}:${port}/v1/chat/completions`);
    console.log(`   • JSON Ask Endpoint     : http://${displayHost}:${port}/v1/ask`);
    console.log(`   • Danh sách Models      : http://${displayHost}:${port}/v1/models\n`);
  });
}
