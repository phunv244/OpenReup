"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { Seg } from "@/components/ui";
import { AgyCliChatPanel } from "@/components/AgyCliChatPanel";

type QuotaEntry = {
  displayName?: string;
  remainingPercentage?: number;
  resetAt?: string | null;
};

type AgyAccount = {
  id: string;
  priority: number;
  name: string;
  email: string;
  projectId: string;
  tierId: string;
  isActive: boolean;
  status: string;
  locks: Record<string, string>;
  totalRequests: number;
  totalFallbacksFrom: number;
  lastError: string | null;
  errorCode: number | null;
  quotas: Record<string, QuotaEntry> | null;
};

type AgySettings = {
  strategy: "fill-first" | "round-robin";
  defaultModel: string;
  requireApiKey: boolean;
  apiKey: string;
};

type AgyModel = { id: string; name?: string };

const PRIORITY_QUOTA_KEYS = [
  "gemini_session",
  "gemini_weekly",
  "gemini_argon_session",
  "gemini_argon_weekly",
  "claude_gpt_session",
  "claude_gpt_weekly",
];

export default function AgyProxyPage() {
  const toast = useToast();
  const [tab, setTab] = useState<"proxy" | "cli">("proxy");
  const [origin, setOrigin] = useState("http://localhost:3456");
  const [accounts, setAccounts] = useState<AgyAccount[]>([]);
  const [models, setModels] = useState<AgyModel[]>([]);
  const [settings, setSettings] = useState<AgySettings>({
    strategy: "fill-first",
    defaultModel: "gemini-3.8-flash",
    requireApiKey: false,
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [quotaBusy, setQuotaBusy] = useState(false);

  // OAuth Modal state
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthState, setOauthState] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthMsg, setOauthMsg] = useState("");
  const [manualInput, setManualInput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Test chat state
  const [testModel, setTestModel] = useState("gemini-3.8-flash");
  const [testPrompt, setTestPrompt] = useState("Xin chào! Hãy trả lời ngắn gọn 1 câu bằng tiếng Việt.");
  const [testStream, setTestStream] = useState(true);
  const [testBusy, setTestBusy] = useState(false);
  const [testMeta, setTestMeta] = useState("");
  const [testOutput, setTestOutput] = useState("Kết quả trả về sẽ hiển thị tại đây...");

  const loadAll = useCallback(async () => {
    try {
      const [accRes, cfgRes, modRes] = await Promise.all([
        fetch("/api/agy-proxy/accounts"),
        fetch("/api/agy-proxy/settings"),
        fetch("/v1/models"),
      ]);
      const accData = await accRes.json();
      const cfgData = await cfgRes.json();
      const modData = await modRes.json();

      if (accData.accounts) setAccounts(accData.accounts);
      if (cfgData.settings) {
        setSettings(cfgData.settings);
        setTestModel((prev) => prev || cfgData.settings.defaultModel || "gemini-3.8-flash");
      }
      if (modData.data) setModels(modData.data);
    } catch (e: unknown) {
      toast(`Không tải được dữ liệu AGY Proxy: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadAll();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadAll]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  async function startOAuth() {
    setOauthOpen(true);
    setManualInput("");
    setOauthUrl("");
    setOauthState("");
    setOauthMsg("Đang khởi tạo phiên đăng nhập Google OAuth...");
    try {
      const res = await fetch("/api/agy-proxy/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOauthMsg(`Lỗi: ${data.error || "Không tạo được phiên OAuth"}`);
        return;
      }
      setOauthState(data.state);
      setOauthUrl(data.authUrl);
      setOauthMsg("Đang chờ bạn xác nhận đăng nhập trên Google...");
      window.open(data.authUrl, "agy_oauth", "width=560,height=700");

      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const stRes = await fetch(`/api/agy-proxy/oauth/status?state=${encodeURIComponent(data.state)}`);
          const st = await stRes.json();
          if (st.status === "done") {
            stopPolling();
            setOauthOpen(false);
            toast(`Đã kết nối tài khoản ${st.account?.email || ""}`, "success");
            await loadAll();
          } else if (st.status === "error") {
            stopPolling();
            setOauthMsg(`Lỗi: ${st.error}`);
          }
        } catch {}
      }, 1500);
    } catch (e: unknown) {
      setOauthMsg(`Lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function submitManualOAuth() {
    if (!oauthState || !manualInput.trim()) return;
    setOauthMsg("Đang xác thực mã OAuth...");
    const res = await fetch("/api/agy-proxy/oauth/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: oauthState, callbackUrl: manualInput.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setOauthMsg(`Lỗi: ${data.error || "Xác thực thất bại"}`);
      return;
    }
    stopPolling();
    setOauthOpen(false);
    toast(`Đã thêm tài khoản ${data.account?.email || ""}`, "success");
    await loadAll();
  }

  async function moveAccount(id: string, delta: number) {
    const ids = accounts.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await fetch("/api/agy-proxy/accounts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await loadAll();
  }

  async function toggleAccount(acc: AgyAccount) {
    await fetch(`/api/agy-proxy/accounts/${encodeURIComponent(acc.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !acc.isActive }),
    });
    toast(acc.isActive ? "Đã tạm tắt tài khoản" : "Đã bật lại tài khoản", "success");
    await loadAll();
  }

  async function unlockAccount(id: string) {
    await fetch(`/api/agy-proxy/accounts/${encodeURIComponent(id)}/unlock`, { method: "POST" });
    toast("Đã mở khóa cooldown tài khoản", "success");
    await loadAll();
  }

  async function removeAccount(acc: AgyAccount) {
    if (!confirm(`Xóa tài khoản ${acc.email || acc.name} khỏi AGY Proxy?`)) return;
    await fetch(`/api/agy-proxy/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" });
    toast("Đã xóa tài khoản", "success");
    await loadAll();
  }

  async function refreshQuotaOne(id: string) {
    toast("Đang lấy quota trực tiếp từ Google...", "info");
    await fetch(`/api/agy-proxy/quota/${encodeURIComponent(id)}?force=1`);
    await loadAll();
    toast("Đã cập nhật quota", "success");
  }

  async function refreshQuotaAll() {
    setQuotaBusy(true);
    try {
      await fetch("/api/agy-proxy/quota?force=1");
      await loadAll();
      toast("Đã làm mới quota tất cả tài khoản", "success");
    } finally {
      setQuotaBusy(false);
    }
  }

  async function saveSettings(extra: Record<string, unknown> = {}) {
    const res = await fetch("/api/agy-proxy/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, ...extra }),
    });
    const data = await res.json();
    if (data.settings) setSettings(data.settings);
    toast("Đã lưu cấu hình AGY Proxy", "success");
  }

  async function runTestChat() {
    if (!testPrompt.trim()) return;
    setTestBusy(true);
    setTestMeta("");
    setTestOutput("Đang gửi request qua endpoint chung...");
    const t0 = performance.now();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.requireApiKey && settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: testModel,
          stream: testStream,
          messages: [{ role: "user", content: testPrompt }],
        }),
      });
      const accEmail = res.headers.get("X-AGY-Account-Email") || "";
      const accPrio = res.headers.get("X-AGY-Account-Priority") || "";
      const fbCount = Number(res.headers.get("X-AGY-Fallback-Count") || 0);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setTestMeta(`Lỗi HTTP ${res.status}`);
        setTestOutput(JSON.stringify(errData, null, 2));
        return;
      }

      const formatMeta = (extra = "") =>
        `Xử lý bởi TK #${accPrio} (${accEmail})` +
        (fbCount > 0 ? ` · Đã tự động fallback qua ${fbCount} TK` : "") +
        ` · ${Math.round(performance.now() - t0)}ms${extra}`;

      if (!testStream || !res.body) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message || {};
        setTestOutput(
          (msg.reasoning_content ? `[Suy nghĩ]\n${msg.reasoning_content}\n\n[Trả lời]\n` : "") +
            (msg.content || "")
        );
        setTestMeta(formatMeta(data.usage ? ` · ${data.usage.total_tokens} tokens` : ""));
        await loadAll();
        return;
      }

      setTestOutput("");
      setTestMeta(formatMeta());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let reasoning = "";
      let content = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
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
            setTestOutput((reasoning ? `[Suy nghĩ]\n${reasoning}\n\n[Trả lời]\n` : "") + content);
          } catch {}
        }
      }
      setTestMeta(formatMeta());
      await loadAll();
    } catch (e: unknown) {
      setTestOutput(`Lỗi: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestBusy(false);
    }
  }

  function copyText(txt: string, label: string) {
    navigator.clipboard.writeText(txt);
    toast(`Đã sao chép ${label}`, "success");
  }

  const keyDisplay = settings.requireApiKey && settings.apiKey ? settings.apiKey : "not-needed";
  const snippet = `# Chuẩn OpenAI (/v1/chat/completions):
curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -d '{"model":"${settings.defaultModel}","messages":[{"role":"user","content":"Xin chào!"}]}'

# Gọi JSON rút gọn (/v1/ask):
curl ${origin}/v1/ask \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -d '{"prompt":"Dịch sang tiếng Việt: 一念永恒","model":"${settings.defaultModel}"}'`;

  return (
    <>
      <Topbar
        title="Tài khoản Antigravity (Multi-Account Proxy)"
        sub="1 Endpoint dùng chung · Hết quota tài khoản #1 tự động fallback sang #2, #3..."
        actions={
          <>
            <button className="btn btn-light btn-sm" type="button" onClick={refreshQuotaAll} disabled={quotaBusy}>
              <Icon name="refresh" size={14} /> {quotaBusy ? "Đang tải..." : "Kiểm tra Quota"}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={startOAuth}>
              <Icon name="plus" size={14} /> Đăng nhập OAuth AGY
            </button>
          </>
        }
      />

      <div className="page">
        <div style={{ marginBottom: 16 }}>
          <Seg
            value={tab}
            onChange={(v) => setTab(v as "proxy" | "cli")}
            items={[
              { v: "proxy", label: "Tài khoản & Proxy API" },
              { v: "cli", label: "Chat trực tiếp agy CLI (Sửa code)" },
            ]}
          />
        </div>

        {tab === "cli" ? (
          <AgyCliChatPanel models={models} origin={origin} />
        ) : (
        <>
        {/* Thanh địa chỉ Endpoint dùng chung */}
        <div className="card">
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 13 }}>
              <span>
                <strong>OpenAI Base URL:</strong>{" "}
                <code style={{ padding: "3px 7px", borderRadius: 6, background: "var(--fill)" }}>{origin}/v1</code>
              </span>
              <span>
                <strong>JSON nhanh:</strong>{" "}
                <code style={{ padding: "3px 7px", borderRadius: 6, background: "var(--fill)" }}>{origin}/v1/ask</code>
              </span>
            </div>
            <button className="btn btn-light btn-sm" type="button" onClick={() => copyText(`${origin}/v1`, "Base URL")}>
              <Icon name="copy" size={14} /> Chép Base URL
            </button>
          </div>
        </div>

        {/* Danh sách Tài khoản */}
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="users" size={16} /> Danh sách Tài khoản ({accounts.length})
            </h3>
            <span className="hint">Thứ tự #1 → #2 → #3 là thứ tự ưu tiên fallback khi hết quota</span>
          </div>
          <div className="card-body">
            {loading ? (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>Đang tải danh sách tài khoản...</div>
            ) : accounts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px 12px", color: "var(--muted)", fontSize: 13.5 }}>
                Chưa có tài khoản Antigravity nào. Bấm <strong>“Đăng nhập OAuth AGY”</strong> ở góc trên hoặc chạy{" "}
                <code>npm run agy:login</code> để thêm tài khoản #1, #2...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {accounts.map((acc, idx) => {
                  const lockEntries = Object.entries(acc.locks || {});
                  const quotaEntries: Array<[string, QuotaEntry]> = [];
                  if (acc.quotas) {
                    for (const k of PRIORITY_QUOTA_KEYS) {
                      if (acc.quotas[k]) quotaEntries.push([k, acc.quotas[k]]);
                    }
                    if (!quotaEntries.length) {
                      for (const [k, v] of Object.entries(acc.quotas).slice(0, 6)) {
                        if (typeof v?.remainingPercentage === "number") quotaEntries.push([k, v]);
                      }
                    }
                  }

                  return (
                    <div
                      key={acc.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: "12px 14px",
                        opacity: acc.isActive ? 1 : 0.55,
                        background: "var(--surface)",
                      }}
                    >
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className="badge blue" style={{ fontWeight: 700 }}>#{idx + 1}</span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span>{acc.email || acc.name}</span>
                              {!acc.isActive ? (
                                <span className="badge gray">Đã tắt</span>
                              ) : lockEntries.length > 0 ? (
                                <span className="badge amber">
                                  Cooldown tới {new Date(lockEntries[0][1]).toLocaleTimeString("vi-VN", { hour12: false })}
                                </span>
                              ) : (
                                <span className="badge green">Sẵn sàng</span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                              Project: <code>{acc.projectId || "auto"}</code> · Đã xử lý: <strong>{acc.totalRequests}</strong> req · Đã fallback:{" "}
                              <strong>{acc.totalFallbacksFrom}</strong> lần
                              {acc.lastError && (
                                <div style={{ color: "var(--red)", marginTop: 2 }}>
                                  Lỗi gần nhất [{acc.errorCode || ""}]: {acc.lastError}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <button className="btn btn-light btn-sm" type="button" disabled={idx === 0} onClick={() => moveAccount(acc.id, -1)} title="Đẩy lên ưu tiên cao hơn">
                            ↑
                          </button>
                          <button className="btn btn-light btn-sm" type="button" disabled={idx === accounts.length - 1} onClick={() => moveAccount(acc.id, 1)} title="Hạ xuống ưu tiên thấp hơn">
                            ↓
                          </button>
                          <button className="btn btn-light btn-sm" type="button" onClick={() => refreshQuotaOne(acc.id)}>
                            Quota
                          </button>
                          {(lockEntries.length > 0 || acc.lastError) && (
                            <button className="btn btn-light btn-sm" type="button" onClick={() => unlockAccount(acc.id)}>
                              Mở khóa
                            </button>
                          )}
                          <button className="btn btn-light btn-sm" type="button" onClick={() => toggleAccount(acc)}>
                            {acc.isActive ? "Tắt" : "Bật"}
                          </button>
                          <button className="btn btn-light btn-sm danger" type="button" onClick={() => removeAccount(acc)}>
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </div>

                      {quotaEntries.length > 0 && (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                            gap: 8,
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: "1px dashed var(--border)",
                          }}
                        >
                          {quotaEntries.map(([k, q]) => {
                            const pct = Math.max(0, Math.min(100, Math.round(q.remainingPercentage || 0)));
                            const barColor = pct <= 10 ? "var(--red)" : pct <= 35 ? "var(--amber)" : "var(--green)";
                            return (
                              <div key={k} style={{ background: "var(--fill)", padding: "7px 10px", borderRadius: 8, fontSize: 12 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                                  <span>{q.displayName || k}</span>
                                  <strong style={{ color: barColor }}>{pct}%</strong>
                                </div>
                                <div style={{ height: 5, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${pct}%`, background: barColor }} />
                                </div>
                                {q.resetAt && (
                                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                                    Reset: {new Date(q.resetAt).toLocaleString("vi-VN", { hour12: false })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 2 cột: Test trực tiếp + Cấu hình */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, marginTop: 18 }}>
          <div className="card" style={{ marginTop: 0 }}>
            <div className="card-head">
              <h3>
                <Icon name="play" size={15} /> Test gọi API & Fallback trực tiếp
              </h3>
            </div>
            <div className="card-body">
              <div className="field">
                <label>Model Antigravity</label>
                <select value={testModel} onChange={(e) => setTestModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id} ({m.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Nội dung thử nghiệm</label>
                <textarea rows={3} value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <button className="btn btn-primary btn-sm" type="button" onClick={runTestChat} disabled={testBusy}>
                  {testBusy ? "Đang gửi..." : "Gửi thử qua Endpoint chung"}
                </button>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", margin: 0 }}>
                  <input type="checkbox" checked={testStream} onChange={(e) => setTestStream(e.target.checked)} />
                  Stream SSE
                </label>
              </div>
              {testMeta && <div style={{ fontSize: 12.5, color: "var(--accent-text)", marginBottom: 8 }}>{testMeta}</div>}
              <pre
                style={{
                  background: "var(--fill)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 12.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  minHeight: 88,
                  margin: 0,
                }}
              >
                {testOutput}
              </pre>
            </div>
          </div>

          <div className="card" style={{ marginTop: 0 }}>
            <div className="card-head">
              <h3>
                <Icon name="sliders" size={15} /> Cấu hình Fallback & Mã kết nối
              </h3>
            </div>
            <div className="card-body">
              <div className="field">
                <label>Chiến lược chọn tài khoản</label>
                <select
                  value={settings.strategy}
                  onChange={(e) => setSettings({ ...settings, strategy: e.target.value as AgySettings["strategy"] })}
                >
                  <option value="fill-first">Ưu tiên tuần tự (Dùng TK #1 → hết quota sang TK #2)</option>
                  <option value="round-robin">Xoay vòng đều giữa các tài khoản (Round-Robin)</option>
                </select>
              </div>
              <div className="field">
                <label>Model mặc định</label>
                <select value={settings.defaultModel} onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value })}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id} ({m.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.requireApiKey}
                    onChange={(e) => setSettings({ ...settings, requireApiKey: e.target.checked })}
                  />
                  Yêu cầu API Key khi app ngoài gọi vào /v1/*
                </label>
              </div>
              <div className="field">
                <label>API Key nội bộ</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={settings.apiKey}
                    onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                    placeholder="sk-agy-..."
                  />
                  <button className="btn btn-light btn-sm" type="button" onClick={() => saveSettings({ regenerateApiKey: true })}>
                    Tạo Key
                  </button>
                </div>
              </div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => saveSettings()}>
                Lưu cấu hình
              </button>

              <div style={{ marginTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <strong style={{ fontSize: 12.5 }}>Ví dụ gọi nhanh</strong>
                  <button className="btn btn-light btn-sm" type="button" onClick={() => copyText(snippet, "đoạn lệnh mẫu")}>
                    <Icon name="copy" size={13} /> Chép
                  </button>
                </div>
                <pre
                  style={{
                    background: "var(--fill)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 11.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                  }}
                >
                  {snippet}
                </pre>
              </div>
            </div>
          </div>
        </div>
        </>
        )}
      </div>

      {oauthOpen && (
        <Modal
          title="Đăng nhập Tài khoản Antigravity (Google OAuth)"
          onClose={() => {
            stopPolling();
            setOauthOpen(false);
          }}
        >
          <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 0 }}>
            Bấm nút bên dưới để mở trang đăng nhập Google. Nếu trình duyệt chạy cùng máy với server, tài khoản sẽ{" "}
            <strong>tự động lưu ngay sau khi bạn bấm Cho phép</strong>.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {oauthUrl && (
              <a href={oauthUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: "none" }}>
                <Icon name="external" size={14} /> Mở trang Đăng nhập Google
              </a>
            )}
            {oauthUrl && (
              <button className="btn btn-light btn-sm" type="button" onClick={() => copyText(oauthUrl, "link OAuth")}>
                <Icon name="copy" size={14} /> Chép link OAuth
              </button>
            )}
          </div>
          <div style={{ fontSize: 13, color: "var(--accent-text)", marginBottom: 14 }}>{oauthMsg}</div>

          <div style={{ background: "var(--fill)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Đang chạy trên VPS / Máy từ xa?</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
              Sau khi đăng nhập xong, copy toàn bộ URL dạng <code>http://localhost:xxxxx/callback?code=...</code> trên thanh địa chỉ dán vào đây:
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="http://localhost:xxxxx/callback?code=4/0A..."
              />
              <button className="btn btn-primary btn-sm" type="button" onClick={submitManualOAuth}>
                Xác nhận
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
