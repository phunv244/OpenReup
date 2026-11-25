"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";

type ToolBadge = {
  stepIndex: number;
  stepType: string;
  state: string;
  detail?: string;
};

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolBadge[];
  meta?: string;
  error?: boolean;
};

type AgyModel = { id: string; name?: string };

export function AgyCliChatPanel({ models, origin }: { models: AgyModel[]; origin: string }) {
  const toast = useToast();
  const [cwd, setCwd] = useState("/var/www/html/reupDouyin");
  const [mode, setMode] = useState<"accept-edits" | "full-auto" | "plan">("accept-edits");
  const [model, setModel] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeRunId, setActiveRunId] = useState("");
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/agy-cli/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.defaultCwd) setCwd(d.defaultCwd);
        setCliAvailable(Boolean(d.available));
      })
      .catch(() => setCliAvailable(false));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function startNewConversation() {
    if (busy) return;
    setConversationId("");
    setMessages([]);
    toast("Đã bắt đầu cuộc trò chuyện mới với agy CLI", "info");
  }

  async function abortRun() {
    if (!activeRunId) return;
    await fetch("/api/agy-cli/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: activeRunId }),
    }).catch(() => {});
    toast("Đã gửi lệnh dừng agy CLI", "info");
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: ChatMsg = { id: `u_${Date.now()}`, role: "user", content: text };
    const botId = `a_${Date.now() + 1}`;
    const botMsg: ChatMsg = { id: botId, role: "assistant", content: "", tools: [] };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    setInput("");
    setBusy(true);
    setActiveRunId("");

    const updateBot = (fn: (m: ChatMsg) => ChatMsg) => {
      setMessages((prev) => prev.map((m) => (m.id === botId ? fn(m) : m)));
    };

    try {
      const res = await fetch("/api/agy-cli/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          cwd: cwd.trim(),
          mode,
          model: model || undefined,
          conversationId: conversationId || undefined,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        updateBot((m) => ({ ...m, content: err.error || "Lỗi không xác định", error: true }));
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const rawLine of lines) {
          if (!rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (!payload) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          if (evt.type === "start" && typeof evt.runId === "string") {
            setActiveRunId(evt.runId);
          } else if (evt.type === "init" && typeof evt.conversationId === "string" && evt.conversationId) {
            setConversationId(evt.conversationId);
          } else if (evt.type === "delta") {
            const txtDelta = String(evt.text || "");
            const thinkDelta = String(evt.thinking || "");
            updateBot((m) => ({
              ...m,
              content: m.content + txtDelta,
              thinking: thinkDelta ? (m.thinking || "") + thinkDelta : m.thinking,
            }));
          } else if (evt.type === "tool") {
            const tb: ToolBadge = {
              stepIndex: Number(evt.stepIndex || 0),
              stepType: String(evt.stepType || "tool"),
              state: String(evt.state || "ACTIVE"),
              detail: String(evt.detail || ""),
            };
            updateBot((m) => {
              const list = [...(m.tools || [])];
              const idx = list.findIndex((t) => t.stepIndex === tb.stepIndex && t.stepType === tb.stepType);
              if (idx >= 0) list[idx] = tb;
              else list.push(tb);
              return { ...m, tools: list };
            });
          } else if (evt.type === "result") {
            if (typeof evt.conversationId === "string" && evt.conversationId) {
              setConversationId(evt.conversationId);
            }
            const usage = evt.usage as { total_tokens?: number } | null;
            const dur = typeof evt.durationSeconds === "number" ? `${evt.durationSeconds.toFixed(1)}s` : "";
            const tok = usage?.total_tokens ? `${usage.total_tokens.toLocaleString()} tokens` : "";
            const finalResp = String(evt.response || "");
            updateBot((m) => ({
              ...m,
              content: m.content.trim() ? m.content : finalResp,
              meta: [dur, tok].filter(Boolean).join(" · "),
            }));
          } else if (evt.type === "error") {
            updateBot((m) => ({
              ...m,
              content: (m.content ? m.content + "\n\n" : "") + `⚠ ${String(evt.message || "Lỗi agy CLI")}`,
              error: true,
            }));
          }
        }
      }
    } catch (e: unknown) {
      updateBot((m) => ({
        ...m,
        content: `Lỗi kết nối: ${e instanceof Error ? e.message : String(e)}`,
        error: true,
      }));
    } finally {
      setBusy(false);
      setActiveRunId("");
    }
  }

  const apiExample = `# Gọi API agy CLI từ script (JSON, có thể tự sửa code trong cwd):
curl -X POST ${origin}/api/agy-cli/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "cwd": "${cwd}",
    "mode": "${mode}",
    "message": "Kiểm tra git status và tóm tắt thay đổi mới nhất"
  }'`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Thanh cấu hình phiên agy CLI */}
      <div className="card" style={{ marginTop: 0 }}>
        <div className="card-head">
          <h3>
            <Icon name="terminal" size={16} /> Phiên làm việc trực tiếp với agy CLI
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {cliAvailable === true && <span className="badge green">agy CLI sẵn sàng</span>}
            {cliAvailable === false && <span className="badge red">Không thấy lệnh agy</span>}
            <button className="btn btn-light btn-sm" type="button" onClick={startNewConversation} disabled={busy}>
              <Icon name="plus" size={14} /> Hội thoại mới
            </button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Thư mục mã nguồn (cwd)</label>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                disabled={busy}
                placeholder="/var/www/html/reupDouyin"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Quyền thao tác của agy CLI</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "accept-edits" | "full-auto" | "plan")}
                disabled={busy}
              >
                <option value="accept-edits">Tự động sửa file (accept-edits — khuyên dùng)</option>
                <option value="full-auto">Toàn quyền sửa file & chạy lệnh (full-auto)</option>
                <option value="plan">Chỉ đọc & phân tích, không sửa file (plan)</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Model agy CLI</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                <option value="">Mặc định của agy CLI</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id} ({m.id})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {conversationId && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
              Đang nối tiếp hội thoại: <code>{conversationId}</code> (các tin nhắn tiếp theo sẽ giữ nguyên ngữ cảnh)
            </div>
          )}
        </div>
      </div>

      {/* Khung Chat trực tiếp */}
      <div className="card" style={{ marginTop: 0 }}>
        <div className="card-head">
          <h3>
            <Icon name="sparkles" size={15} /> Khung Chat điều khiển agy CLI (đọc / sửa mã nguồn trực tiếp)
          </h3>
          <span className="hint">Tách biệt hoàn toàn với luồng reup video</span>
        </div>
        <div className="card-body">
          <div
            ref={scrollRef}
            style={{
              minHeight: 300,
              maxHeight: 500,
              overflowY: "auto",
              background: "var(--fill)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", fontSize: 13.5, maxWidth: 480 }}>
                Nhập yêu cầu bên dưới để giao trực tiếp cho <strong>agy CLI</strong> thực thi trong thư mục{" "}
                <code>{cwd}</code>.<br />
                Ví dụ: <em>&ldquo;Đọc file package.json và giải thích các script&rdquo;</em> hoặc{" "}
                <em>&ldquo;Sửa lỗi nhỏ ở file ...&rdquo;</em>.
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "88%",
                    background: m.role === "user" ? "var(--accent)" : "var(--surface)",
                    color: m.role === "user" ? "#fff" : "var(--text)",
                    border: m.role === "user" ? "none" : "1px solid var(--border)",
                    borderRadius: 12,
                    padding: "10px 14px",
                    fontSize: 13.5,
                  }}
                >
                  {m.tools && m.tools.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                      {m.tools.map((t, idx) => (
                        <span
                          key={`${t.stepIndex}-${idx}`}
                          className={`badge ${t.state === "DONE" ? "green" : "amber"}`}
                          style={{ fontSize: 11 }}
                        >
                          {t.state === "DONE" ? "✓" : "⏳"} {t.stepType}
                          {t.detail ? `: ${t.detail}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
                    {m.content || (busy && m.role === "assistant" ? "Đang xử lý..." : "")}
                  </div>
                  {m.meta && (
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, textAlign: "right" }}>
                      {m.meta}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Nhập yêu cầu cho agy CLI... (Enter để gửi, Shift+Enter xuống dòng)"
              disabled={busy}
              style={{ flex: 1, margin: 0 }}
            />
            {busy ? (
              <button className="btn btn-danger btn-sm" type="button" onClick={abortRun} style={{ height: 42 }}>
                <Icon name="stop" size={14} /> Dừng
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={sendMessage}
                disabled={!input.trim()}
                style={{ height: 42 }}
              >
                <Icon name="play" size={14} /> Gửi
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Ví dụ gọi API từ script ngoài */}
      <div className="card" style={{ marginTop: 0 }}>
        <div className="card-head">
          <h3>
            <Icon name="book" size={15} /> Gọi API agy CLI từ script / công cụ ngoài
          </h3>
          <button
            className="btn btn-light btn-sm"
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(apiExample);
              toast("Đã sao chép lệnh mẫu API agy CLI", "success");
            }}
          >
            <Icon name="copy" size={13} /> Chép
          </button>
        </div>
        <div className="card-body">
          <pre
            style={{
              background: "var(--fill)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
            }}
          >
            {apiExample}
          </pre>
        </div>
      </div>
    </div>
  );
}
