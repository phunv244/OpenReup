"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { EmptyState, Metric, Seg, copyText } from "@/components/ui";
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
  oauthClientSecretSet?: boolean;
  oauth?: { configured: boolean; clientId: string; fromEnv: boolean };
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

const DEFAULT_SETTINGS: AgySettings = { strategy: "fill-first", defaultModel: "gemini-3.8-flash", requireApiKey: false, apiKey: "" };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "còn 12 phút" / "còn 2 giờ 5 phút" tính từ bây giờ tới mốc ISO; "" nếu đã qua. */
function fmtIn(iso: string): string {
  const min = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(min) || min <= 0) return "";
  if (min < 60) return `còn ${min} phút`;
  const h = Math.floor(min / 60);
  if (h < 48) return `còn ${h} giờ${min % 60 ? ` ${min % 60} phút` : ""}`;
  return `còn ${Math.floor(h / 24)} ngày`;
}
const fmtAt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour12: false });

/** Gọi API quản lý; ném lỗi kèm thông báo của server để mọi thao tác đều báo được khi thất bại. */
async function api<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Lỗi máy chủ (HTTP ${res.status})`);
  return data as T;
}

function pickQuotas(quotas: AgyAccount["quotas"]): Array<[string, QuotaEntry]> {
  if (!quotas) return [];
  const picked = PRIORITY_QUOTA_KEYS.filter((k) => quotas[k]).map((k): [string, QuotaEntry] => [k, quotas[k]]);
  if (picked.length) return picked;
  return Object.entries(quotas)
    .filter(([, v]) => typeof v?.remainingPercentage === "number")
    .slice(0, 6);
}

function QuotaBar({ name, q }: { name: string; q: QuotaEntry }) {
  const pct = Math.max(0, Math.min(100, Math.round(q.remainingPercentage || 0)));
  const left = q.resetAt ? fmtIn(q.resetAt) : "";
  return (
    <div className={`agy-quota ${pct <= 10 ? "red" : pct <= 35 ? "amber" : "green"}`}>
      <div className="agy-quota-top">
        <span>{q.displayName || name}</span>
        <strong>{pct}%</strong>
      </div>
      <div className="progress">
        <div style={{ width: `${pct}%` }} />
      </div>
      {q.resetAt && (
        <div className="agy-quota-reset" title={fmtAt(q.resetAt)}>
          Làm mới: {left || fmtAt(q.resetAt)}
        </div>
      )}
    </div>
  );
}

export default function AgyProxyPage() {
  const toast = useToast();
  const [tab, setTab] = useState<"proxy" | "cli">("proxy");
  const [origin, setOrigin] = useState("http://localhost:3456");
  const [accounts, setAccounts] = useState<AgyAccount[]>([]);
  const [models, setModels] = useState<AgyModel[]>([]);
  const [settings, setSettings] = useState<AgySettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<AgySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [busyId, setBusyId] = useState(""); // tài khoản đang có thao tác chạy

  // OAuth Modal state
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthState, setOauthState] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthMsg, setOauthMsg] = useState("");
  const [manualInput, setManualInput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Nhập Client ID / Secret của Antigravity (khi .env chưa đặt AGY_CLIENT_ID/SECRET)
  const [credId, setCredId] = useState("");
  const [credSecret, setCredSecret] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  // Test chat state
  const [testModel, setTestModel] = useState("");
  const [testPrompt, setTestPrompt] = useState("Xin chào! Hãy trả lời ngắn gọn 1 câu bằng tiếng Việt.");
  const [testStream, setTestStream] = useState(true);
  const [testBusy, setTestBusy] = useState(false);
  const [testMeta, setTestMeta] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const testAbort = useRef<AbortController | null>(null);

  /** Chỉ tải lại danh sách tài khoản (mọi thao tác đều gọi) — cấu hình và model chỉ tải 1 lần lúc mở trang. */
  const loadAccounts = useCallback(
    async (silent = false) => {
      try {
        const data = await api<{ accounts: AgyAccount[] }>("/api/agy-proxy/accounts");
        setAccounts(data.accounts || []);
      } catch (e) {
        if (!silent) toast(`Không tải được danh sách tài khoản: ${errMsg(e)}`, "error");
      }
    },
    [toast]
  );

  useEffect(() => {
    setOrigin(window.location.origin);
    Promise.all([
      loadAccounts(),
      api<{ settings: AgySettings }>("/api/agy-proxy/settings")
        .then((d) => {
          setSettings(d.settings);
          setSavedSettings(d.settings);
          setTestModel((prev) => prev || d.settings.defaultModel);
        })
        .catch((e) => toast(`Không tải được cấu hình: ${errMsg(e)}`, "error")),
      api<{ data: AgyModel[] }>("/api/agy-proxy/models")
        .then((d) => setModels(d.data || []))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      testAbort.current?.abort();
    };
  }, [loadAccounts, toast]);

  // Cooldown / số request thay đổi khi các job dịch đang chạy: tự làm mới mỗi 30 giây lúc tab đang mở.
  useEffect(() => {
    if (tab !== "proxy") return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadAccounts(true);
    }, 30_000);
    return () => clearInterval(t);
  }, [tab, loadAccounts]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  /** Lưu Client ID/Secret vào proxy (settings.json), rồi tải lại cấu hình. Trả về true nếu đã đủ credential. */
  async function saveOAuthCreds(): Promise<boolean> {
    setSavingCreds(true);
    try {
      const d = await api<{ settings: AgySettings }>("/api/agy-proxy/settings", "POST", {
        oauthClientId: credId.trim(),
        oauthClientSecret: credSecret.trim(),
      });
      setSettings(d.settings);
      setSavedSettings(d.settings);
      setCredSecret("");
      const ok = Boolean(d.settings.oauth?.configured);
      toast(ok ? "Đã lưu credential OAuth" : "Đã lưu, nhưng credential chưa đủ", ok ? "success" : "error");
      return ok;
    } catch (e) {
      toast(`Không lưu được credential: ${errMsg(e)}`, "error");
      return false;
    } finally {
      setSavingCreds(false);
    }
  }

  async function startOAuth() {
    setOauthOpen(true);
    setManualInput("");
    setOauthUrl("");
    setOauthState("");
    if (!settings.oauth?.configured) {
      setOauthMsg("Trước tiên hãy nhập Client ID và Client Secret của Antigravity bên dưới, rồi bấm Lưu để bắt đầu đăng nhập.");
      return;
    }
    setOauthMsg("Đang khởi tạo phiên đăng nhập Google OAuth...");
    try {
      const data = await api<{ state: string; authUrl: string }>("/api/agy-proxy/oauth/start", "POST", {});
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
            await loadAccounts();
          } else if (st.status === "error") {
            stopPolling();
            setOauthMsg(`Lỗi: ${st.error}`);
          } else if (st.status === "unknown") {
            // server khởi động lại / phiên hết hạn: không poll mãi
            stopPolling();
            setOauthMsg("Phiên đăng nhập đã hết hạn, vui lòng bấm kết nối lại.");
          }
        } catch {}
      }, 1500);
    } catch (e) {
      setOauthMsg(`Lỗi: ${errMsg(e)}`);
    }
  }

  async function submitManualOAuth() {
    if (!oauthState || !manualInput.trim()) return;
    setOauthMsg("Đang xác thực mã OAuth...");
    try {
      const data = await api<{ account?: { email?: string } }>("/api/agy-proxy/oauth/manual", "POST", {
        state: oauthState,
        callbackUrl: manualInput.trim(),
      });
      stopPolling();
      setOauthOpen(false);
      toast(`Đã thêm tài khoản ${data.account?.email || ""}`, "success");
      await loadAccounts();
    } catch (e) {
      setOauthMsg(`Lỗi: ${errMsg(e)}`);
    }
  }

  /** Chạy 1 thao tác trên tài khoản: khóa nút của dòng đó, báo lỗi nếu hỏng, rồi tải lại danh sách. */
  async function act(id: string, run: () => Promise<unknown>, okMsg: string) {
    setBusyId(id);
    try {
      await run();
      toast(okMsg, "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      await loadAccounts(true);
      setBusyId("");
    }
  }

  async function moveAccount(idx: number, delta: number) {
    const j = idx + delta;
    if (j < 0 || j >= accounts.length) return;
    const next = [...accounts];
    [next[idx], next[j]] = [next[j], next[idx]];
    setAccounts(next); // đổi chỗ ngay trên màn hình, server lưu sau
    try {
      await api("/api/agy-proxy/accounts/reorder", "POST", { ids: next.map((a) => a.id) });
    } catch (e) {
      toast(errMsg(e), "error");
      await loadAccounts(true);
    }
  }

  const accUrl = (id: string) => `/api/agy-proxy/accounts/${encodeURIComponent(id)}`;
  const toggleAccount = (acc: AgyAccount) =>
    act(acc.id, () => api(accUrl(acc.id), "PATCH", { isActive: !acc.isActive }), acc.isActive ? "Đã tạm tắt tài khoản" : "Đã bật lại tài khoản");
  const unlockAccount = (id: string) => act(id, () => api(`${accUrl(id)}/unlock`, "POST"), "Đã mở khóa cooldown tài khoản");
  const refreshQuotaOne = (id: string) =>
    act(id, () => api(`/api/agy-proxy/quota/${encodeURIComponent(id)}?force=1`), "Đã cập nhật quota");
  function removeAccount(acc: AgyAccount) {
    if (!confirm(`Xóa tài khoản ${acc.email || acc.name} khỏi AGY Proxy?`)) return;
    act(acc.id, () => api(accUrl(acc.id), "DELETE"), "Đã xóa tài khoản");
  }

  async function refreshQuotaAll() {
    setQuotaBusy(true);
    try {
      await api("/api/agy-proxy/quota?force=1");
      toast("Đã làm mới quota tất cả tài khoản", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      await loadAccounts(true);
      setQuotaBusy(false);
    }
  }

  async function saveSettings(extra: Record<string, unknown> = {}) {
    try {
      const data = await api<{ settings: AgySettings }>("/api/agy-proxy/settings", "POST", { ...settings, ...extra });
      setSettings(data.settings);
      setSavedSettings(data.settings);
      toast("Đã lưu cấu hình AGY Proxy", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  async function runTestChat() {
    if (!testPrompt.trim()) return;
    const ctrl = new AbortController();
    testAbort.current = ctrl;
    setTestBusy(true);
    setTestMeta("");
    setTestOutput("Đang gửi request qua endpoint chung...");
    const t0 = performance.now();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (savedSettings.requireApiKey && savedSettings.apiKey) {
      headers.Authorization = `Bearer ${savedSettings.apiKey}`;
    }

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model: testModel || savedSettings.defaultModel,
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
        let changed = false;
        for (const l of lines) {
          if (!l.startsWith("data:")) continue;
          const p = l.slice(5).trim();
          if (!p || p === "[DONE]") continue;
          try {
            const d = JSON.parse(p).choices?.[0]?.delta || {};
            if (d.reasoning_content) reasoning += d.reasoning_content;
            if (d.content) content += d.content;
            changed = true;
          } catch {}
        }
        // 1 lần vẽ lại cho mỗi gói mạng, không phải mỗi dòng SSE
        if (changed) setTestOutput((reasoning ? `[Suy nghĩ]\n${reasoning}\n\n[Trả lời]\n` : "") + content);
      }
      setTestMeta(formatMeta());
    } catch (e) {
      if (ctrl.signal.aborted) setTestMeta("Đã dừng");
      else setTestOutput(`Lỗi: ${errMsg(e)}`);
    } finally {
      setTestBusy(false);
      loadAccounts(true);
    }
  }

  const copy = (txt: string) => copyText(txt, toast);

  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const active = accounts.filter((a) => a.isActive);
  const cooling = active.filter((a) => Object.keys(a.locks || {}).length > 0).length;
  const totalReq = accounts.reduce((n, a) => n + (a.totalRequests || 0), 0);
  const totalFb = accounts.reduce((n, a) => n + (a.totalFallbacksFrom || 0), 0);
  // Model đang lưu có thể không còn trong danh sách upstream: vẫn hiện để không tự đổi sang model khác.
  const modelOptions = (cur: string) => (cur && !models.some((m) => m.id === cur) ? [{ id: cur }, ...models] : models);

  const keyDisplay = savedSettings.requireApiKey && savedSettings.apiKey ? savedSettings.apiKey : "not-needed";
  const snippet = `# Chuẩn OpenAI (/v1/chat/completions):
curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -d '{"model":"${savedSettings.defaultModel}","messages":[{"role":"user","content":"Xin chào!"}]}'

# Gọi JSON rút gọn (/v1/ask):
curl ${origin}/v1/ask \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -d '{"prompt":"Dịch sang tiếng Việt: 一念永恒","model":"${savedSettings.defaultModel}"}'`;

  return (
    <>
      <Topbar
        title="Tài khoản Antigravity"
        sub="1 endpoint dùng chung · hết quota tài khoản #1 tự chuyển sang #2, #3..."
        actions={
          <>
            <button className="btn btn-light btn-sm" type="button" onClick={refreshQuotaAll} disabled={quotaBusy || !accounts.length}>
              <Icon name="refresh" size={14} /> {quotaBusy ? "Đang tải..." : "Kiểm tra quota"}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={startOAuth}>
              <Icon name="plus" size={14} /> Thêm tài khoản
            </button>
          </>
        }
      />

      <div className="page">
        <div className="agy-tabs">
          <Seg
            value={tab}
            onChange={(v) => setTab(v as "proxy" | "cli")}
            items={[
              { v: "proxy", label: "Tài khoản & Proxy API" },
              { v: "cli", label: "Chat agy CLI (sửa code)" },
            ]}
          />
        </div>

        {/* Giữ panel luôn gắn: đổi tab không làm mất hội thoại hay ngắt lượt agy CLI đang chạy. */}
        <div hidden={tab !== "cli"}>
          <AgyCliChatPanel models={models} origin={origin} />
        </div>
        {tab === "proxy" && (
          <>
            <div className="metrics">
              <Metric
                icon="users"
                label="Tài khoản sẵn sàng"
                value={`${active.length - cooling}/${accounts.length}`}
                sub={cooling ? `${cooling} đang cooldown` : accounts.length - active.length ? `${accounts.length - active.length} đã tắt` : ""}
                tone={accounts.length && active.length - cooling === 0 ? "pink" : "green"}
              />
              <Metric icon="play" label="Request đã xử lý" value={totalReq.toLocaleString("vi-VN")} tone="blue" />
              <Metric icon="refresh" label="Lượt chuyển tài khoản" value={totalFb.toLocaleString("vi-VN")} sub="do hết quota / lỗi" tone="violet" />
            </div>

            <div className="card">
              <div className="card-body agy-endpoint">
                <span>
                  <strong>OpenAI Base URL</strong> <code>{origin}/v1</code>
                  <button className="icon-btn" type="button" title="Chép Base URL" aria-label="Chép Base URL" onClick={() => copy(`${origin}/v1`)}>
                    <Icon name="copy" size={14} />
                  </button>
                </span>
                <span>
                  <strong>JSON nhanh</strong> <code>{origin}/v1/ask</code>
                  <button className="icon-btn" type="button" title="Chép địa chỉ /v1/ask" aria-label="Chép địa chỉ /v1/ask" onClick={() => copy(`${origin}/v1/ask`)}>
                    <Icon name="copy" size={14} />
                  </button>
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>
                  <Icon name="users" size={16} /> Tài khoản ({accounts.length})
                </h3>
                <span className="hint">Thứ tự #1 → #2 → #3 là thứ tự ưu tiên khi hết quota</span>
              </div>
              {loading ? (
                <div className="card-body muted">Đang tải danh sách tài khoản...</div>
              ) : accounts.length === 0 ? (
                <div className="card-body">
                  <EmptyState
                    icon="key"
                    title="Chưa có tài khoản Antigravity nào"
                    desc="Thêm tài khoản để bước dịch tự dùng proxy và tự chuyển tài khoản khi hết quota. Cũng có thể chạy: npm run agy:login"
                  >
                    <button className="btn btn-primary btn-sm" type="button" onClick={startOAuth}>
                      <Icon name="plus" size={14} /> Thêm tài khoản
                    </button>
                  </EmptyState>
                </div>
              ) : (
                accounts.map((acc, idx) => {
                  const locks = Object.values(acc.locks || {}).sort();
                  const lockEnd = locks[locks.length - 1];
                  const quotas = pickQuotas(acc.quotas);
                  const busy = busyId === acc.id;
                  return (
                    <div key={acc.id} className={`agy-acc${acc.isActive ? "" : " off"}`}>
                      <div className="agy-acc-head">
                        <div className="agy-acc-main">
                          <span className="badge blue">#{idx + 1}</span>
                          <div>
                            <div className="agy-acc-name">
                              <span>{acc.email || acc.name}</span>
                              {!acc.isActive ? (
                                <span className="badge gray">Đã tắt</span>
                              ) : lockEnd ? (
                                <span className="badge amber" title={`Tới ${fmtAt(lockEnd)}`}>
                                  Cooldown {fmtIn(lockEnd)}
                                </span>
                              ) : acc.status === "error" ? (
                                <span className="badge red">Lỗi</span>
                              ) : (
                                <span className="badge green">Sẵn sàng</span>
                              )}
                            </div>
                            <div className="agy-acc-sub">
                              Project <code>{acc.projectId || "auto"}</code> · <strong>{acc.totalRequests}</strong> request ·{" "}
                              <strong>{acc.totalFallbacksFrom}</strong> lần chuyển đi
                            </div>
                            {acc.lastError && (
                              <div className="agy-acc-err">
                                Lỗi gần nhất{acc.errorCode ? ` [${acc.errorCode}]` : ""}: {acc.lastError}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="agy-acc-actions">
                          <button className="btn btn-light btn-sm" type="button" disabled={idx === 0} onClick={() => moveAccount(idx, -1)} title="Tăng ưu tiên" aria-label="Tăng ưu tiên">
                            ↑
                          </button>
                          <button className="btn btn-light btn-sm" type="button" disabled={idx === accounts.length - 1} onClick={() => moveAccount(idx, 1)} title="Giảm ưu tiên" aria-label="Giảm ưu tiên">
                            ↓
                          </button>
                          <button className="btn btn-light btn-sm" type="button" disabled={busy} onClick={() => refreshQuotaOne(acc.id)}>
                            <Icon name="refresh" size={13} /> Quota
                          </button>
                          {(locks.length > 0 || acc.lastError) && (
                            <button className="btn btn-light btn-sm" type="button" disabled={busy} onClick={() => unlockAccount(acc.id)}>
                              Mở khóa
                            </button>
                          )}
                          <button className="btn btn-light btn-sm" type="button" disabled={busy} onClick={() => toggleAccount(acc)}>
                            {acc.isActive ? "Tắt" : "Bật"}
                          </button>
                          <button className="btn btn-light btn-sm danger" type="button" disabled={busy} onClick={() => removeAccount(acc)} title="Xóa tài khoản" aria-label="Xóa tài khoản">
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </div>

                      {quotas.length > 0 && (
                        <div className="agy-quotas">
                          {quotas.map(([k, q]) => (
                            <QuotaBar key={k} name={k} q={q} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="cols cols-2 agy-cols">
              <div className="card">
                <div className="card-head">
                  <h3>
                    <Icon name="play" size={15} /> Gọi thử API
                  </h3>
                </div>
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="agy-test-model">Model</label>
                    <select id="agy-test-model" className="select" value={testModel} onChange={(e) => setTestModel(e.target.value)}>
                      {modelOptions(testModel).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name ? `${m.name} (${m.id})` : m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="agy-test-prompt">Nội dung</label>
                    <textarea id="agy-test-prompt" className="input" rows={3} value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} />
                  </div>
                  <div className="agy-row agy-test-bar">
                    {testBusy ? (
                      <button className="btn btn-light btn-sm" type="button" onClick={() => testAbort.current?.abort()}>
                        <Icon name="stop" size={13} /> Dừng
                      </button>
                    ) : (
                      <button className="btn btn-primary btn-sm" type="button" onClick={runTestChat} disabled={!accounts.length || !testPrompt.trim()}>
                        <Icon name="play" size={13} /> Gửi thử
                      </button>
                    )}
                    <label className="check">
                      <input type="checkbox" checked={testStream} onChange={(e) => setTestStream(e.target.checked)} />
                      Stream SSE
                    </label>
                  </div>
                  {testMeta && <div className="agy-test-meta">{testMeta}</div>}
                  <pre className="agy-out" aria-live="polite">
                    {testOutput || <span className="muted">Kết quả trả về sẽ hiển thị tại đây...</span>}
                  </pre>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>
                    <Icon name="sliders" size={15} /> Cấu hình
                  </h3>
                  {dirty && <span className="badge amber">Chưa lưu</span>}
                </div>
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="agy-strategy">Cách chọn tài khoản</label>
                    <select
                      id="agy-strategy"
                      className="select"
                      value={settings.strategy}
                      onChange={(e) => setSettings({ ...settings, strategy: e.target.value as AgySettings["strategy"] })}
                    >
                      <option value="fill-first">Tuần tự: dùng #1, hết quota mới sang #2</option>
                      <option value="round-robin">Xoay vòng đều giữa các tài khoản</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="agy-default-model">Model mặc định</label>
                    <select
                      id="agy-default-model"
                      className="select"
                      value={settings.defaultModel}
                      onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value })}
                    >
                      {modelOptions(settings.defaultModel).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name ? `${m.name} (${m.id})` : m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.requireApiKey}
                        onChange={(e) => setSettings({ ...settings, requireApiKey: e.target.checked })}
                      />
                      Yêu cầu API Key khi app ngoài gọi vào /v1/*
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="agy-api-key">API Key nội bộ</label>
                    <div className="agy-row">
                      <input
                        id="agy-api-key"
                        className="input"
                        type="text"
                        value={settings.apiKey}
                        onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                        placeholder="sk-agy-..."
                      />
                      <button className="btn btn-light btn-sm" type="button" onClick={() => saveSettings({ regenerateApiKey: true })}>
                        Tạo key mới
                      </button>
                    </div>
                  </div>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => saveSettings()} disabled={!dirty}>
                    Lưu cấu hình
                  </button>

                  <div className="agy-snippet-head">
                    <strong>Ví dụ gọi nhanh</strong>
                    <button className="btn btn-light btn-sm" type="button" onClick={() => copy(snippet)}>
                      <Icon name="copy" size={13} /> Chép
                    </button>
                  </div>
                  <pre className="agy-out small">{snippet}</pre>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {oauthOpen && (
        <Modal
          title="Thêm tài khoản Antigravity (Google OAuth)"
          onClose={() => {
            stopPolling();
            setOauthOpen(false);
          }}
        >
          <p className="lead">
            Mở trang đăng nhập Google. Nếu trình duyệt chạy cùng máy với server, tài khoản sẽ{" "}
            <strong>tự lưu ngay sau khi bạn bấm Cho phép</strong>.
          </p>

          {!settings.oauth?.configured ? (
            <div className="agy-remote">
              <label htmlFor="agy-cred-id">Bước 1 — Credential OAuth của Antigravity</label>
              <p>
                Lấy <code>AGY_CLIENT_ID</code> và <code>AGY_CLIENT_SECRET</code> từ máy đã cài Antigravity (hoặc file <code>.env</code> máy khác) rồi dán vào đây. Lưu một lần, không cần khởi động lại server.
              </p>
              <div className="agy-row">
                <input
                  id="agy-cred-id"
                  className="input"
                  type="text"
                  value={credId}
                  onChange={(e) => setCredId(e.target.value)}
                  placeholder="Client ID (…apps.googleusercontent.com)"
                />
              </div>
              <div className="agy-row">
                <input
                  className="input"
                  type="password"
                  value={credSecret}
                  onChange={(e) => setCredSecret(e.target.value)}
                  placeholder="Client Secret (GOCSPX-…)"
                />
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={savingCreds || !credId.trim() || !credSecret.trim()}
                  onClick={async () => {
                    if (await saveOAuthCreds()) startOAuth();
                  }}
                >
                  {savingCreds ? "Đang lưu…" : "Lưu & đăng nhập"}
                </button>
              </div>
            </div>
          ) : (
            !oauthUrl && (
              <div className="agy-row agy-test-bar">
                <button className="btn btn-primary btn-sm" type="button" onClick={startOAuth}>
                  <Icon name="external" size={14} /> Bắt đầu đăng nhập Google
                </button>
              </div>
            )
          )}

          {oauthUrl && (
            <div className="agy-row agy-test-bar">
              <a href={oauthUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                <Icon name="external" size={14} /> Mở trang đăng nhập Google
              </a>
              <button className="btn btn-light btn-sm" type="button" onClick={() => copy(oauthUrl)}>
                <Icon name="copy" size={14} /> Chép link
              </button>
            </div>
          )}
          <div className="agy-test-meta" aria-live="polite">{oauthMsg}</div>

          <div className="agy-remote">
            <label htmlFor="agy-callback">Đang chạy trên VPS / máy từ xa?</label>
            <p>
              Đăng nhập xong, copy toàn bộ URL dạng <code>http://localhost:xxxxx/callback?code=...</code> trên thanh địa chỉ rồi dán vào đây:
            </p>
            <div className="agy-row">
              <input
                id="agy-callback"
                className="input"
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="http://localhost:xxxxx/callback?code=4/0A..."
              />
              <button className="btn btn-primary btn-sm" type="button" onClick={submitManualOAuth} disabled={!oauthState || !manualInput.trim()}>
                Xác nhận
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
