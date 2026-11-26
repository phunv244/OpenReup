import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import { ANTIGRAVITY_OAUTH, ANTIGRAVITY_IDE_USER_AGENT, getClientMetadata } from "./constants.mjs";
import { upsertAccount, updateAccount, getAccountById, getSettings } from "./store.mjs";

/** Credential OAuth: ưu tiên biến môi trường (.env), rồi tới giá trị lưu qua giao diện Web (settings.json). */
export function activeOAuthCreds() {
  const s = getSettings();
  return {
    clientId: ANTIGRAVITY_OAUTH.clientId || s.oauthClientId || "",
    clientSecret: ANTIGRAVITY_OAUTH.clientSecret || s.oauthClientSecret || "",
  };
}

export function hasOAuthCredentials() {
  const c = activeOAuthCreds();
  return Boolean(c.clientId && c.clientSecret);
}

function assertOAuthCredentials() {
  if (!hasOAuthCredentials()) {
    throw new Error(
      "Thiếu AGY_CLIENT_ID hoặc AGY_CLIENT_SECRET. Nhập trong giao diện Web (mục Kết nối tài khoản) hoặc đặt trong file .env."
    );
  }
}

/**
 * Build Google OAuth2 authorization URL for Antigravity
 */
export function buildAuthUrl(redirectUri, state) {
  assertOAuthCredentials();
  const params = new URLSearchParams({
    client_id: activeOAuthCreds().clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTIGRAVITY_OAUTH.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${ANTIGRAVITY_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access_token & refresh_token
 */
export async function exchangeCodeForTokens(code, redirectUri) {
  assertOAuthCredentials();
  const creds = activeOAuthCreds();
  const res = await fetch(ANTIGRAVITY_OAUTH.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Đổi mã OAuth thất bại (${res.status}): ${errText}`);
  }
  return await res.json();
}

/**
 * Fetch Google profile (email, name, picture)
 */
export async function fetchGoogleUserInfo(accessToken) {
  const res = await fetch(`${ANTIGRAVITY_OAUTH.userInfoUrl}?alt=json`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return {};
  return await res.json();
}

/**
 * Load Code Assist project & tier, and onboard if needed (mirrors 9router's exact headers)
 * Real Antigravity IDE does NOT send X-Goog-Api-Client / Client-Metadata headers here.
 */
export async function loadAndOnboardProject(accessToken, waitOnboard = false) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
  };
  const metadata = getClientMetadata();

  let projectId = "";
  let tierId = "legacy-tier";

  try {
    const res = await fetch(ANTIGRAVITY_OAUTH.loadCodeAssistEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata }),
    });
    if (res.ok) {
      const data = await res.json();
      const rawProj = data.cloudaicompanionProject;
      projectId = typeof rawProj === "object" && rawProj !== null ? rawProj.id || "" : String(rawProj || "");
      if (Array.isArray(data.allowedTiers)) {
        for (const t of data.allowedTiers) {
          if (t.isDefault && t.id) {
            tierId = t.id.trim();
            break;
          }
        }
      }
      if (data.paidTier?.id) {
        tierId = data.paidTier.id;
      }
    }
  } catch (err) {
    console.warn("[OAuth] loadCodeAssist warning:", err.message);
  }

  const runOnboard = async () => {
    for (let i = 0; i < 8; i++) {
      try {
        const res = await fetch(ANTIGRAVITY_OAUTH.onboardUserEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ tierId, metadata }),
        });
        if (!res.ok) break;
        const result = await res.json();
        if (result.done === true) {
          const respProj = result.response?.cloudaicompanionProject;
          const finalId = typeof respProj === "string" ? respProj.trim() : respProj?.id?.trim();
          return finalId || projectId;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return projectId;
  };

  if (waitOnboard) {
    const finalPid = await runOnboard();
    if (finalPid) projectId = finalPid;
  } else if (!onboardInflight.has(accessToken)) {
    // Chạy nền 1 lượt cho mỗi token: request kế tiếp không khởi động thêm vòng onboard trùng.
    // Onboard xong thì loadCodeAssist ở request sau tự trả projectId.
    onboardInflight.add(accessToken);
    runOnboard()
      .catch(() => {})
      .finally(() => onboardInflight.delete(accessToken));
  }

  return { projectId, tierId };
}

/**
 * Complete full OAuth exchange -> userInfo -> loadCodeAssist -> persist account
 */
export async function finalizeOAuthCode(code, redirectUri, { waitOnboard = false, customName = "" } = {}) {
  const tokens = await exchangeCodeForTokens(code, redirectUri);
  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  const { projectId, tierId } = await loadAndOnboardProject(tokens.access_token, waitOnboard);

  const account = await upsertAccount({
    name: customName || userInfo.name || userInfo.email || "Antigravity Account",
    email: userInfo.email || "",
    picture: userInfo.picture || "",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    projectId,
    tierId,
  });

  return account;
}

// In-flight token refresh dedup per account
const refreshInflight = new Map();
const onboardInflight = new Set();

/**
 * Refresh access token for an account (or return current if still fresh)
 */
export async function ensureFreshToken(account, { force = false } = {}) {
  if (!account) return null;
  if (!force && account.accessToken && account.expiresAt) {
    const remainingMs = new Date(account.expiresAt).getTime() - Date.now();
    if (remainingMs > ANTIGRAVITY_OAUTH.refreshLeadMs) {
      return account;
    }
  }

  if (!account.refreshToken) {
    return account;
  }

  if (refreshInflight.has(account.id)) {
    return refreshInflight.get(account.id);
  }

  // Request khác vừa refresh xong: dùng token mới đó, không đốt lại refresh token cũ (có thể đã bị xoay vòng).
  const latest = getAccountById(account.id);
  if (latest) {
    if (latest.accessToken && latest.accessToken !== account.accessToken) return latest;
    account = latest;
  }

  const promise = (async () => {
    const res = await fetch(ANTIGRAVITY_OAUTH.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: activeOAuthCreds().clientId,
        client_secret: activeOAuthCreds().clientSecret,
      }),
      signal: AbortSignal.timeout(15_000), // socket treo không được giữ refreshInflight mãi
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Refresh token failed (${res.status}): ${txt.slice(0, 200)}`);
    }

    const tokens = await res.json();
    const expiresIn = tokens.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    let projectId = account.projectId;
    if (!projectId && tokens.access_token) {
      const loaded = await loadAndOnboardProject(tokens.access_token, false);
      projectId = loaded.projectId || "";
    }

    const updated = await updateAccount(account.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || account.refreshToken,
      expiresIn,
      expiresAt,
      projectId,
      lastRefreshAt: new Date().toISOString(),
    });
    return updated || { ...account, accessToken: tokens.access_token, expiresAt, projectId };
  })();

  refreshInflight.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshInflight.delete(account.id);
  }
}

// ─── Interactive OAuth Sessions (shared by Web UI & CLI) ──────────────────────

const oauthSessions = new Map(); // state -> session

function isLoopbackOrigin(origin) {
  if (!origin) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function renderCallbackHtml(ok, title, detail) {
  const color = ok ? "#10b981" : "#ef4444";
  const icon = ok ? "✓" : "✕";
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px 40px; text-align: center; max-width: 440px; box-shadow: 0 20px 40px rgba(0,0,0,.4); }
    .badge { width: 64px; height: 64px; border-radius: 50%; background: ${color}22; color: ${color}; font-size: 32px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
    h2 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0; color: #94a3b8; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h2>${title}</h2>
    <p id="sub">${detail}</p>
  </div>
  ${ok ? `<script>setTimeout(() => { window.close(); document.getElementById("sub").textContent = "Bạn có thể đóng tab này lại."; }, 1500);</script>` : ""}
</body>
</html>`;
}

/**
 * Start an OAuth login session with an ephemeral localhost callback server.
 * Supports BOTH automatic localhost browser redirect AND manual callback URL paste (for remote VPS/SSH).
 */
export async function startOAuthSession({ customName = "", timeoutMs = 5 * 60 * 1000 } = {}) {
  // Kiểm tra trước khi mở cổng callback: ném lỗi bên trong callback "listening" sẽ làm sập cả server.
  assertOAuthCredentials();
  const state = crypto.randomBytes(24).toString("base64url");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403);
        res.end("Forbidden origin");
        return;
      }

      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const err = url.searchParams.get("error");

      const session = oauthSessions.get(state);
      if (!session || session.status === "done") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(true, "Phiên đã hoàn tất", "Bạn có thể đóng cửa sổ này."));
        return;
      }

      if (returnedState && returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(false, "State không khớp", "Vui lòng thử đăng nhập lại từ đầu."));
        return;
      }

      if (err || !code) {
        session.status = "error";
        session.error = url.searchParams.get("error_description") || err || "Không nhận được mã xác thực";
        session.cleanup();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(false, "Đăng nhập thất bại", session.error));
        session._reject?.(new Error(session.error));
        return;
      }

      session.status = "exchanging";
      try {
        const account = await finalizeOAuthCode(code, session.redirectUri, {
          waitOnboard: false,
          customName: session.customName,
        });
        session.status = "done";
        session.account = account;
        session.cleanup();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderCallbackHtml(
            true,
            "Đăng nhập Antigravity thành công!",
            `Đã kết nối ${account.email || account.name}. Cửa sổ này sẽ tự đóng...`
          )
        );
        session._resolve?.(account);
      } catch (exErr) {
        session.status = "error";
        session.error = exErr.message;
        session.cleanup();
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(false, "Lỗi trao đổi Token", exErr.message));
        session._reject?.(exErr);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const redirectUri = `http://localhost:${port}/callback`;
      const authUrl = buildAuthUrl(redirectUri, state);

      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          server.close();
        } catch {}
        // Keep finished session entry for 2 minutes so Web UI polling can read it
        setTimeout(() => oauthSessions.delete(state), 120_000).unref?.();
      };

      let _resolve, _reject;
      const waitPromise = new Promise((resP, rejP) => {
        _resolve = resP;
        _reject = rejP;
      });
      // Prevent unhandledRejection when only polling via Web UI
      waitPromise.catch(() => {});

      timer = setTimeout(() => {
        const s = oauthSessions.get(state);
        if (s && s.status === "pending") {
          s.status = "error";
          s.error = "Hết thời gian chờ đăng nhập (5 phút)";
          cleanup();
          _reject?.(new Error(s.error));
        }
      }, timeoutMs);
      timer.unref?.();

      const session = {
        state,
        port,
        redirectUri,
        authUrl,
        customName,
        status: "pending",
        account: null,
        error: null,
        cleanup,
        waitPromise,
        _resolve,
        _reject,
      };
      oauthSessions.set(state, session);

      resolve({
        state,
        port,
        redirectUri,
        authUrl,
        waitForCompletion: () => waitPromise,
        cancel: () => {
          session.status = "cancelled";
          cleanup();
        },
      });
    });

    server.on("error", (err) => reject(err));
  });
}

export function getOAuthSessionStatus(state) {
  const s = oauthSessions.get(state);
  if (!s) return { status: "unknown" };
  return {
    state: s.state,
    status: s.status,
    error: s.error,
    account: s.account
      ? {
          id: s.account.id,
          name: s.account.name,
          email: s.account.email,
          projectId: s.account.projectId,
          priority: s.account.priority,
        }
      : null,
  };
}

/**
 * Complete an active OAuth session manually using a pasted callback URL or raw code
 * (useful when running the proxy on a remote VPS where localhost redirect doesn't reach the server).
 */
export async function completeOAuthSessionManually(state, callbackUrlOrCode) {
  const s = oauthSessions.get(state);
  if (!s) {
    throw new Error("Không tìm thấy phiên đăng nhập (hoặc đã hết hạn). Hãy bấm Đăng nhập lại.");
  }
  if (s.status === "done" && s.account) return s.account;

  let code = String(callbackUrlOrCode || "").trim();
  if (!code) throw new Error("Vui lòng dán URL callback hoặc mã code.");

  if (code.startsWith("http://") || code.startsWith("https://") || code.includes("code=")) {
    try {
      const parsed = new URL(code.startsWith("http") ? code : `http://localhost/?${code}`);
      const urlState = parsed.searchParams.get("state");
      if (urlState && urlState !== state) {
        throw new Error("Tham số state trong URL không khớp với phiên đăng nhập hiện tại.");
      }
      code = parsed.searchParams.get("code") || "";
    } catch (e) {
      if (e.message.includes("state")) throw e;
      const m = code.match(/[?&]code=([^&]+)/);
      if (m) code = decodeURIComponent(m[1]);
    }
  }

  if (!code) throw new Error("Không tìm thấy mã `code` hợp lệ trong chuỗi bạn vừa dán.");

  s.status = "exchanging";
  try {
    const account = await finalizeOAuthCode(code, s.redirectUri, {
      waitOnboard: true,
      customName: s.customName,
    });
    s.status = "done";
    s.account = account;
    s.cleanup();
    s._resolve?.(account);
    return account;
  } catch (err) {
    s.status = "error";
    s.error = err.message;
    s.cleanup();
    s._reject?.(err);
    throw err;
  }
}

/**
 * Try opening URL in system default browser (best-effort, silent fail on headless Linux)
 */
export function openBrowserBestEffort(url) {
  const p = os.platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    if (p === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }
    const child = execFile(cmd, args, { stdio: "ignore" }, () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
