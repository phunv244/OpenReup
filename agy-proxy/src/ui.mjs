export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AGY Multi-Account Proxy</title>
  <style>
    :root {
      --bg: #0b1120;
      --panel: #131c31;
      --panel-hover: #192540;
      --border: #263554;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --green: #10b981;
      --red: #ef4444;
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 60px; }
    header {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 16px; margin-bottom: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 42px; height: 42px; border-radius: 12px;
      background: linear-gradient(135deg, #f59e0b, #ea580c);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 800; color: #fff;
    }
    h1 { margin: 0; font-size: 21px; font-weight: 700; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--border); background: var(--panel); color: var(--text);
      padding: 8px 14px; border-radius: 9px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: 0.15s;
    }
    .btn:hover { background: var(--panel-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); border-color: var(--accent); color: #0b1120; }
    .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn-sm { padding: 5px 10px; font-size: 12px; border-radius: 7px; }
    .btn-danger { color: #fca5a5; border-color: #7f1d1d; }
    .btn-danger:hover { background: #450a0a; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 920px) { .grid-2 { grid-template-columns: 1.15fr 0.85fr; } }
    .card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 14px; padding: 20px;
    }
    .card-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin-bottom: 14px;
    }
    .card-title { margin: 0; font-size: 16px; font-weight: 700; }
    .endpoint-bar {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
      background: #090e1a; border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 14px; margin-bottom: 20px; font-size: 13px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 5px; font-size: 12.5px;
    }
    .acc-list { display: flex; flex-direction: column; gap: 12px; }
    .acc-item {
      background: #0d1526; border: 1px solid var(--border); border-radius: 11px;
      padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .acc-item.disabled { opacity: 0.55; }
    .acc-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    .acc-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .prio {
      min-width: 30px; height: 30px; border-radius: 8px; background: #1e293b;
      border: 1px solid #334155; display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 13px; color: var(--accent);
    }
    .acc-email { font-weight: 600; font-size: 14px; word-break: break-all; }
    .acc-meta { font-size: 12px; color: var(--muted); }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 99px;
      font-size: 11px; font-weight: 600;
    }
    .badge-ok { background: rgba(16,185,129,0.15); color: #34d399; }
    .badge-warn { background: rgba(245,158,11,0.18); color: #fbbf24; }
    .badge-off { background: rgba(148,163,184,0.15); color: #94a3b8; }
    .acc-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .quota-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(195px, 1fr));
      gap: 8px; padding-top: 8px; border-top: 1px dashed #1e293b;
    }
    .q-box { background: #111a2e; padding: 7px 10px; border-radius: 8px; font-size: 11.5px; }
    .q-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .q-bar { height: 5px; background: #1e293b; border-radius: 4px; overflow: hidden; }
    .q-fill { height: 100%; background: var(--green); transition: width 0.3s; }
    .form-row { margin-bottom: 12px; }
    label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 5px; font-weight: 500; }
    input, select, textarea {
      width: 100%; background: #090e1a; border: 1px solid var(--border); color: var(--text);
      padding: 9px 11px; border-radius: 8px; font-size: 13.5px; font-family: inherit;
    }
    textarea { resize: vertical; min-height: 76px; }
    pre {
      background: #080c17; border: 1px solid var(--border); border-radius: 9px;
      padding: 12px; overflow-x: auto; font-size: 12px; margin: 8px 0 0; color: #cbd5e1;
      white-space: pre-wrap; word-break: break-word;
    }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: none; align-items: center; justify-content: center; padding: 16px; z-index: 50;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: var(--panel); border: 1px solid var(--border); border-radius: 16px;
      max-width: 520px; width: 100%; padding: 22px;
    }
    .toast {
      position: fixed; bottom: 20px; right: 20px; background: #1e293b; border: 1px solid #475569;
      padding: 10px 16px; border-radius: 10px; font-size: 13px; display: none; z-index: 100;
    }
    .empty { text-align: center; padding: 28px 12px; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <div class="logo">A</div>
        <div>
          <h1>Antigravity Multi-Account Proxy</h1>
          <div class="sub">1 Endpoint chung • Tự động Fallback sang tài khoản kế tiếp khi hết Quota</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn" onclick="refreshAllQuotas()" id="btnQuotaAll">↻ Kiểm tra Quota tất cả</button>
        <button class="btn btn-primary" onclick="openOAuthModal()">+ Đăng nhập OAuth Antigravity</button>
      </div>
    </header>

    <div class="endpoint-bar">
      <span><strong>OpenAI Base URL:</strong> <code id="baseUrlTxt"></code></span>
      <span>•</span>
      <span><strong>Chat API:</strong> <code id="chatUrlTxt"></code></span>
      <span>•</span>
      <span><strong>JSON nhanh:</strong> <code id="askUrlTxt"></code></span>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-head">
          <div>
            <h2 class="card-title">Danh sách Tài khoản Antigravity (<span id="accCount">0</span>)</h2>
            <div class="sub">Tài khoản #1 được ưu tiên dùng trước. Khi hết quota (429/409), tác vụ tự động chuyển ngay sang #2, #3...</div>
          </div>
          <button class="btn btn-sm" onclick="loadState()">Làm mới</button>
        </div>
        <div id="accContainer" class="acc-list">
          <div class="empty">Đang tải danh sách tài khoản...</div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head">
            <h2 class="card-title">Test gọi API & Fallback trực tiếp</h2>
          </div>
          <div class="form-row">
            <label>Model Antigravity</label>
            <select id="testModel"></select>
          </div>
          <div class="form-row">
            <label>Nội dung thử nghiệm</label>
            <textarea id="testPrompt">Xin chào! Hãy trả lời ngắn gọn 1 câu bằng tiếng Việt.</textarea>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn btn-primary" onclick="runTestChat()" id="btnTest">▶ Gửi thử qua Endpoint chung</button>
            <label style="margin:0; display:inline-flex; align-items:center; gap:5px; cursor:pointer;">
              <input type="checkbox" id="testStream" style="width:auto;" checked /> Stream SSE
            </label>
          </div>
          <div id="testMeta" style="margin-top:10px; font-size:12px; color:var(--accent);"></div>
          <pre id="testOutput" style="min-height:90px;">Kết quả trả về sẽ hiển thị tại đây...</pre>
        </div>

        <div class="card">
          <div class="card-head">
            <h2 class="card-title">Cấu hình Định tuyến & Bảo mật</h2>
          </div>
          <div class="form-row">
            <label>Chiến lược chọn tài khoản</label>
            <select id="cfgStrategy">
              <option value="fill-first">Ưu tiên tuần tự (Dùng hết TK #1 → tự fallback sang TK #2)</option>
              <option value="round-robin">Xoay vòng đều giữa các tài khoản (Round-Robin)</option>
            </select>
          </div>
          <div class="form-row">
            <label>Model mặc định (khi request không truyền model)</label>
            <select id="cfgDefaultModel"></select>
          </div>
          <div class="form-row">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; color:var(--text);">
              <input type="checkbox" id="cfgRequireKey" style="width:auto;" />
              Yêu cầu API Key (<code>Authorization: Bearer ...</code>) khi gọi vào Proxy
            </label>
          </div>
          <div class="form-row">
            <label>API Key nội bộ (để trống hoặc bấm Tạo mới)</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="cfgApiKey" placeholder="sk-agy-..." />
              <button class="btn btn-sm" onclick="genKey()">Tạo Key</button>
            </div>
          </div>
          <button class="btn btn-primary" onclick="saveConfig()">Lưu cấu hình</button>

          <hr style="border:0; border-top:1px solid var(--border); margin:18px 0;" />
          <div class="card-title" style="font-size:14px; margin-bottom:6px;">Ví dụ tích hợp nhanh (Python / OpenAI SDK / cURL)</div>
          <pre id="codeSnippet"></pre>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal Đăng nhập OAuth -->
  <div class="modal-backdrop" id="oauthModal">
    <div class="modal">
      <div class="card-head">
        <h3 class="card-title">Đăng nhập Tài khoản Antigravity (Google OAuth)</h3>
        <button class="btn btn-sm" onclick="closeOAuthModal()">✕</button>
      </div>
      <p style="font-size:13px; color:var(--muted); margin-top:0;">
        Bấm nút bên dưới để mở trang đăng nhập Google. Nếu trình duyệt chạy cùng máy với server, tài khoản sẽ <strong>tự động lưu ngay sau khi bạn bấm Cho phép</strong>.
      </p>
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        <a id="oauthLinkBtn" href="#" target="_blank" rel="noopener" class="btn btn-primary" style="text-decoration:none;">
          ↗ Mở trang Đăng nhập Google
        </a>
        <button class="btn" onclick="copyAuthUrl()">Sao chép Link OAuth</button>
      </div>
      <div id="oauthStatusTxt" style="font-size:13px; color:var(--accent); margin-bottom:14px;">
        Đang khởi tạo phiên OAuth...
      </div>

      <div style="background:#090e1a; border:1px solid var(--border); border-radius:10px; padding:12px;">
        <label style="color:var(--text); font-weight:600;">
          Đang chạy Proxy trên VPS / Máy từ xa?
        </label>
        <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">
          Sau khi đăng nhập xong, trình duyệt chuyển hướng tới trang <code>http://localhost:.../callback?code=...</code> (báo không kết nối được). Hãy copy toàn bộ URL trên thanh địa chỉ đó dán vào đây:
        </div>
        <div style="display:flex; gap:6px;">
          <input type="text" id="manualCallbackInput" placeholder="http://localhost:xxxxx/callback?code=4/0A..." />
          <button class="btn btn-primary btn-sm" onclick="submitManualCallback()">Xác nhận</button>
        </div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const origin = window.location.origin;
    document.getElementById("baseUrlTxt").textContent = origin + "/v1";
    document.getElementById("chatUrlTxt").textContent = origin + "/v1/chat/completions";
    document.getElementById("askUrlTxt").textContent = origin + "/v1/ask";

    let currentModels = [];
    let currentSettings = {};
    let activeOAuthState = null;
    let oauthPollTimer = null;

    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.display = "none"; }, 3200);
    }

    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    }

    async function loadModels() {
      const res = await fetch("/api/models");
      const data = await res.json();
      currentModels = data.data || [];
      const opts = currentModels.map(m => \`<option value="\${escapeHtml(m.id)}">\${escapeHtml(m.name || m.id)} (\${escapeHtml(m.id)})</option>\`).join("");
      document.getElementById("testModel").innerHTML = opts;
      document.getElementById("cfgDefaultModel").innerHTML = opts;
    }

    function updateSnippet() {
      const key = currentSettings.requireApiKey && currentSettings.apiKey ? currentSettings.apiKey : "not-needed";
      const model = currentSettings.defaultModel || "gemini-3.8-flash";
      document.getElementById("codeSnippet").textContent =
\`# 1. Chuẩn OpenAI SDK (Python / Node / Cursor / Cline):
curl \${origin}/v1/chat/completions \\\\
  -H "Content-Type: application/json" \\\\
  -H "Authorization: Bearer \${key}" \\\\
  -d '{"model":"\${model}","messages":[{"role":"user","content":"Xin chào!"}]}'

# 2. Endpoint rút gọn /v1/ask:
curl \${origin}/v1/ask \\\\
  -H "Content-Type: application/json" \\\\
  -H "Authorization: Bearer \${key}" \\\\
  -d '{"prompt":"Dịch sang tiếng Việt: 你好世界","model":"\${model}"}'\`;
    }

    function renderQuotas(quotas) {
      if (!quotas || typeof quotas !== "object") return "";
      const priorityKeys = [
        "gemini_session", "gemini_weekly",
        "gemini_argon_session", "gemini_argon_weekly",
        "claude_gpt_session", "claude_gpt_weekly"
      ];
      const entries = [];
      for (const k of priorityKeys) {
        if (quotas[k]) entries.push([k, quotas[k]]);
      }
      if (!entries.length) {
        for (const [k, v] of Object.entries(quotas).slice(0, 6)) {
          if (v && typeof v.remainingPercentage === "number") entries.push([k, v]);
        }
      }
      if (!entries.length) return "";
      return \`<div class="quota-grid">\${entries.map(([k, q]) => {
        const pct = Math.max(0, Math.min(100, Math.round(q.remainingPercentage || 0)));
        const color = pct <= 10 ? "#ef4444" : pct <= 35 ? "#f59e0b" : "#10b981";
        const reset = q.resetAt ? new Date(q.resetAt).toLocaleString("vi-VN", { hour12: false }) : "";
        return \`<div class="q-box">
          <div class="q-row">
            <span>\${escapeHtml(q.displayName || k)}</span>
            <strong style="color:\${color}">\${pct}%</strong>
          </div>
          <div class="q-bar"><div class="q-fill" style="width:\${pct}%; background:\${color}"></div></div>
          \${reset ? \`<div style="color:#64748b; font-size:10.5px; margin-top:3px;">Reset: \${escapeHtml(reset)}</div>\` : ""}
        </div>\`;
      }).join("")}</div>\`;
    }

    async function loadState() {
      const [accRes, cfgRes] = await Promise.all([fetch("/api/accounts"), fetch("/api/settings")]);
      const accData = await accRes.json();
      currentSettings = await cfgRes.json();

      document.getElementById("cfgStrategy").value = currentSettings.strategy || "fill-first";
      if (currentSettings.defaultModel) {
        document.getElementById("cfgDefaultModel").value = currentSettings.defaultModel;
        if (!document.getElementById("testModel").dataset.touched) {
          document.getElementById("testModel").value = currentSettings.defaultModel;
        }
      }
      document.getElementById("cfgRequireKey").checked = !!currentSettings.requireApiKey;
      document.getElementById("cfgApiKey").value = currentSettings.apiKey || "";
      updateSnippet();

      const accounts = accData.accounts || [];
      document.getElementById("accCount").textContent = accounts.length;
      const box = document.getElementById("accContainer");

      if (!accounts.length) {
        box.innerHTML = \`<div class="empty">
          Chưa có tài khoản Antigravity nào.<br/>
          Bấm <strong>"+ Đăng nhập OAuth Antigravity"</strong> ở góc trên hoặc chạy <code>npm run login</code> trong terminal để thêm tài khoản #1, #2...
        </div>\`;
        return;
      }

      box.innerHTML = accounts.map((a, idx) => {
        const lockKeys = Object.entries(a.locks || {});
        let badge = \`<span class="badge badge-ok">● Sẵn sàng</span>\`;
        if (!a.isActive) badge = \`<span class="badge badge-off">Đã tắt</span>\`;
        else if (lockKeys.length > 0) {
          const until = new Date(lockKeys[0][1]).toLocaleTimeString("vi-VN", { hour12: false });
          badge = \`<span class="badge badge-warn">⏳ Cooldown tới \${escapeHtml(until)}</span>\`;
        }

        return \`<div class="acc-item \${a.isActive ? "" : "disabled"}">
          <div class="acc-top">
            <div class="acc-info">
              <div class="prio">#\${idx + 1}</div>
              <div>
                <div class="acc-email">
                  \${escapeHtml(a.email || a.name)} \${badge}
                </div>
                <div class="acc-meta">
                  Project: <code>\${escapeHtml(a.projectId || "auto")}</code>
                  • Đã xử lý: <strong>\${a.totalRequests || 0}</strong> req
                  • Chuyển tiếp (fallback): <strong>\${a.totalFallbacksFrom || 0}</strong> lần
                  \${a.lastError ? \`<br/><span style="color:#fca5a5;">Lỗi gần nhất [\${a.errorCode || ""}]: \${escapeHtml(a.lastError)}</span>\` : ""}
                </div>
              </div>
            </div>
            <div class="acc-actions">
              <button class="btn btn-sm" onclick="moveAccount('\${a.id}', -1)" \${idx === 0 ? "disabled" : ""} title="Tăng độ ưu tiên">↑</button>
              <button class="btn btn-sm" onclick="moveAccount('\${a.id}', 1)" \${idx === accounts.length - 1 ? "disabled" : ""} title="Giảm độ ưu tiên">↓</button>
              <button class="btn btn-sm" onclick="checkOneQuota('\${a.id}')">Quota</button>
              \${lockKeys.length > 0 || a.lastError ? \`<button class="btn btn-sm" onclick="unlockAcc('\${a.id}')">Mở khóa</button>\` : ""}
              <button class="btn btn-sm" onclick="toggleAcc('\${a.id}', \${!a.isActive})">\${a.isActive ? "Tắt" : "Bật"}</button>
              <button class="btn btn-sm btn-danger" onclick="removeAcc('\${a.id}')">Xóa</button>
            </div>
          </div>
          \${renderQuotas(a.quotas)}
        </div>\`;
      }).join("");

      window._lastAccounts = accounts;
    }

    document.getElementById("testModel").addEventListener("change", (e) => { e.target.dataset.touched = "1"; });

    async function moveAccount(id, delta) {
      const ids = (window._lastAccounts || []).map(a => a.id);
      const i = ids.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await fetch("/api/accounts/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      });
      await loadState();
    }

    async function toggleAcc(id, isActive) {
      await fetch(\`/api/accounts/\${id}\`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive })
      });
      showToast(isActive ? "Đã bật tài khoản" : "Đã tạm tắt tài khoản");
      await loadState();
    }

    async function unlockAcc(id) {
      await fetch(\`/api/accounts/\${id}/unlock\`, { method: "POST" });
      showToast("Đã xóa trạng thái khóa cooldown");
      await loadState();
    }

    async function removeAcc(id) {
      if (!confirm("Xóa tài khoản Antigravity này khỏi Proxy?")) return;
      await fetch(\`/api/accounts/\${id}\`, { method: "DELETE" });
      showToast("Đã xóa tài khoản");
      await loadState();
    }

    async function checkOneQuota(id) {
      showToast("Đang kiểm tra quota trực tiếp từ Google...");
      await fetch(\`/api/quota/\${id}?force=1\`);
      await loadState();
      showToast("Đã cập nhật quota!");
    }

    async function refreshAllQuotas() {
      const btn = document.getElementById("btnQuotaAll");
      btn.disabled = true;
      btn.textContent = "Đang tải Quota...";
      try {
        await fetch("/api/quota?force=1");
        await loadState();
        showToast("Đã làm mới quota tất cả tài khoản");
      } finally {
        btn.disabled = false;
        btn.textContent = "↻ Kiểm tra Quota tất cả";
      }
    }

    async function genKey() {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerateApiKey: true })
      });
      const cfg = await res.json();
      document.getElementById("cfgApiKey").value = cfg.apiKey || "";
      currentSettings = cfg;
      updateSnippet();
      showToast("Đã tạo API Key mới");
    }

    async function saveConfig() {
      const payload = {
        strategy: document.getElementById("cfgStrategy").value,
        defaultModel: document.getElementById("cfgDefaultModel").value,
        requireApiKey: document.getElementById("cfgRequireKey").checked,
        apiKey: document.getElementById("cfgApiKey").value.trim(),
      };
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      currentSettings = await res.json();
      updateSnippet();
      showToast("Đã lưu cấu hình thành công!");
    }

    // ─── OAuth Flow ────────────────────────────────────────────────────────
    async function openOAuthModal() {
      document.getElementById("oauthModal").classList.add("open");
      document.getElementById("manualCallbackInput").value = "";
      document.getElementById("oauthStatusTxt").textContent = "Đang tạo đường dẫn OAuth...";
      const res = await fetch("/api/oauth/start", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        document.getElementById("oauthStatusTxt").textContent = "Lỗi: " + data.error;
        return;
      }
      activeOAuthState = data.state;
      window._activeAuthUrl = data.authUrl;
      document.getElementById("oauthLinkBtn").href = data.authUrl;
      document.getElementById("oauthStatusTxt").textContent = "⏳ Đang chờ bạn xác nhận đăng nhập trên Google...";

      window.open(data.authUrl, "agy_oauth", "width=560,height=700");

      clearInterval(oauthPollTimer);
      oauthPollTimer = setInterval(async () => {
        if (!activeOAuthState) return;
        const stRes = await fetch(\`/api/oauth/status?state=\${encodeURIComponent(activeOAuthState)}\`);
        const st = await stRes.json();
        if (st.status === "done") {
          clearInterval(oauthPollTimer);
          closeOAuthModal();
          showToast("🎉 Đã thêm tài khoản " + (st.account?.email || ""));
          await loadState();
        } else if (st.status === "error") {
          clearInterval(oauthPollTimer);
          document.getElementById("oauthStatusTxt").textContent = "❌ Lỗi: " + st.error;
        }
      }, 1500);
    }

    function closeOAuthModal() {
      document.getElementById("oauthModal").classList.remove("open");
      clearInterval(oauthPollTimer);
      activeOAuthState = null;
    }

    function copyAuthUrl() {
      if (!window._activeAuthUrl) return;
      navigator.clipboard.writeText(window._activeAuthUrl);
      showToast("Đã sao chép link đăng nhập OAuth!");
    }

    async function submitManualCallback() {
      const val = document.getElementById("manualCallbackInput").value.trim();
      if (!val || !activeOAuthState) return;
      document.getElementById("oauthStatusTxt").textContent = "Đang trao đổi mã xác thực...";
      const res = await fetch("/api/oauth/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: activeOAuthState, callbackUrl: val })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        document.getElementById("oauthStatusTxt").textContent = "❌ " + (data.error || "Xác thực thất bại");
        return;
      }
      closeOAuthModal();
      showToast("🎉 Đã kết nối " + (data.account?.email || "tài khoản mới"));
      await loadState();
    }

    // ─── Live Test Chat ────────────────────────────────────────────────────
    async function runTestChat() {
      const btn = document.getElementById("btnTest");
      const out = document.getElementById("testOutput");
      const meta = document.getElementById("testMeta");
      const model = document.getElementById("testModel").value;
      const prompt = document.getElementById("testPrompt").value.trim();
      const stream = document.getElementById("testStream").checked;
      if (!prompt) return;

      btn.disabled = true;
      out.textContent = "Đang gọi...";
      meta.textContent = "";
      const t0 = performance.now();

      const headers = { "Content-Type": "application/json" };
      if (currentSettings.requireApiKey && currentSettings.apiKey) {
        headers["Authorization"] = "Bearer " + currentSettings.apiKey;
      }

      try {
        const res = await fetch("/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            stream,
            messages: [{ role: "user", content: prompt }]
          })
        });

        const accEmail = res.headers.get("X-AGY-Account-Email") || "";
        const accPrio = res.headers.get("X-AGY-Account-Priority") || "";
        const fbCount = Number(res.headers.get("X-AGY-Fallback-Count") || 0);

        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          out.textContent = JSON.stringify(errJson, null, 2);
          meta.textContent = \`❌ HTTP \${res.status}\`;
          return;
        }

        const renderMeta = (extra = "") => {
          const ms = Math.round(performance.now() - t0);
          meta.textContent = \`✓ Xử lý bởi TK #\${accPrio} (\${accEmail})\`
            + (fbCount > 0 ? \` • Đã tự động fallback qua \${fbCount} TK!\` : "")
            + \` • \${ms}ms\` + extra;
        };

        if (!stream) {
          const data = await res.json();
          const msg = data.choices?.[0]?.message || {};
          out.textContent = (msg.reasoning_content ? \`[Suy nghĩ]\\n\${msg.reasoning_content}\\n\\n[Trả lời]\\n\` : "") + (msg.content || "");
          renderMeta(data.usage ? \` • \${data.usage.total_tokens} tokens\` : "");
          await loadState();
          return;
        }

        out.textContent = "";
        renderMeta();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "", reasoning = "", content = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\\n");
          buf = lines.pop() || "";
          for (const l of lines) {
            if (!l.startsWith("data:")) continue;
            const p = l.slice(5).trim();
            if (!p || p === "[DONE]") continue;
            try {
              const chunk = JSON.parse(p);
              const d = chunk.choices?.[0]?.delta || {};
              if (d.reasoning_content) reasoning += d.reasoning_content;
              if (d.content) content += d.content;
              out.textContent = (reasoning ? \`[Suy nghĩ]\\n\${reasoning}\\n\\n[Trả lời]\\n\` : "") + content;
            } catch {}
          }
        }
        renderMeta();
        await loadState();
      } catch (e) {
        out.textContent = "Lỗi: " + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    loadModels().then(loadState);
  </script>
</body>
</html>`;
}
