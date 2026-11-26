"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";
import { Callout, copyText } from "@/components/ui";

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
  const [cwd, setCwd] = useState(""); // server trả thư mục mặc định ở /api/agy-cli/status
  const [mode, setMode] = useState<"accept-edits" | "full-auto" | "plan">("accept-edits");
  const [model, setModel] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeRunId, setActiveRunId] = useState("");
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // chỉ tự cuộn khi người dùng đang ở cuối khung chat

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
    if (scrollRef.current && stick.current) {
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

    stick.current = true;
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
        // Gộp chữ của cả gói mạng rồi mới vẽ lại 1 lần (agy CLI gửi rất nhiều delta nhỏ).
        let txtAcc = "";
        let thinkAcc = "";

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
            txtAcc += String(evt.text || "");
            thinkAcc += String(evt.thinking || "");
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
        if (txtAcc || thinkAcc) {
          updateBot((m) => ({ ...m, content: m.content + txtAcc, thinking: thinkAcc ? (m.thinking || "") + thinkAcc : m.thinking }));
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
    <div className="cli">
      <div className="card">
        <div className="card-head">
          <h3>
            <Icon name="terminal" size={16} /> Chat với agy CLI
          </h3>
          <div className="agy-row">
            {cliAvailable === true && <span className="badge green">agy CLI sẵn sàng</span>}
            {cliAvailable === false && <span className="badge red">Không thấy lệnh agy</span>}
            <button className="btn btn-light btn-sm" type="button" onClick={startNewConversation} disabled={busy || !messages.length}>
              <Icon name="plus" size={14} /> Hội thoại mới
            </button>
          </div>
        </div>

        <div className="cli-config">
          <div className="field">
            <label htmlFor="cli-cwd">Thư mục mã nguồn</label>
            <input id="cli-cwd" className="input" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={busy} placeholder="/đường/dẫn/dự-án" />
          </div>
          <div className="field">
            <label htmlFor="cli-mode">Quyền của agy CLI</label>
            <select id="cli-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={busy}>
              <option value="accept-edits">Tự sửa file (khuyên dùng)</option>
              <option value="full-auto">Toàn quyền: sửa file và chạy lệnh</option>
              <option value="plan">Chỉ đọc và phân tích</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="cli-model">Model</label>
            <select id="cli-model" className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              <option value="">Mặc định của agy CLI</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ? `${m.name} (${m.id})` : m.id}
                </option>
              ))}
            </select>
          </div>
        </div>
        {mode === "full-auto" && (
          <div className="cli-warn">
            <Callout tone="warn" icon="alert">
              Toàn quyền: agy CLI tự chạy mọi lệnh trong thư mục trên mà không hỏi lại, kể cả lệnh xóa file. Chỉ dùng với thư mục có git hoặc đã sao lưu.
            </Callout>
          </div>
        )}

        <div
          className="cli-log"
          ref={scrollRef}
          role="log"
          aria-label="Hội thoại với agy CLI"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {messages.length === 0 ? (
            <div className="cli-empty">
              <Icon name="sparkles" size={22} />
              <p>
                Giao việc cho <strong>agy CLI</strong> trong thư mục <code>{cwd || "..."}</code>. Tách biệt với luồng reup video.
              </p>
              <div className="chips">
                {["Đọc package.json và giải thích các script", "Kiểm tra git status và tóm tắt thay đổi mới nhất"].map((ex) => (
                  <button key={ex} className="chip" type="button" onClick={() => setInput(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const waiting = busy && m.role === "assistant" && !m.content && m.id === messages[messages.length - 1].id;
              return (
                <div key={m.id} className={`cli-msg ${m.role}${m.error ? " error" : ""}`}>
                  {m.tools && m.tools.length > 0 && (
                    <div className="cli-tools">
                      {m.tools.map((t, idx) => (
                        <span key={`${t.stepIndex}-${idx}`} className={`badge ${t.state === "DONE" ? "green" : "amber"}`} title={t.detail || undefined}>
                          <Icon name={t.state === "DONE" ? "check" : "clock"} size={11} /> {t.stepType}
                          {t.detail ? `: ${t.detail}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.thinking && (
                    <details className="cli-think">
                      <summary>Suy nghĩ của model</summary>
                      <div>{m.thinking}</div>
                    </details>
                  )}
                  <div className="cli-text">{waiting ? <span className="muted">Đang xử lý...</span> : m.content}</div>
                  {m.role === "assistant" && m.content && !waiting && (
                    <div className="cli-meta">
                      <span>{m.meta}</span>
                      <button className="icon-btn" type="button" title="Chép câu trả lời" aria-label="Chép câu trả lời" onClick={() => copyText(m.content, toast)}>
                        <Icon name="copy" size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="cli-composer">
          {conversationId && (
            <div className="cli-conv muted">
              Đang nối tiếp hội thoại <code>{conversationId}</code>
            </div>
          )}
          <div className="agy-row">
            <textarea
              className="input"
              rows={2}
              value={input}
              aria-label="Yêu cầu cho agy CLI"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Nhập yêu cầu... (Enter để gửi, Shift+Enter xuống dòng)"
            />
            {busy ? (
              <button className="btn btn-danger" type="button" onClick={abortRun} disabled={!activeRunId}>
                <Icon name="stop" size={14} /> Dừng
              </button>
            ) : (
              <button className="btn btn-primary" type="button" onClick={sendMessage} disabled={!input.trim() || !cwd.trim() || cliAvailable === false}>
                <Icon name="play" size={14} /> Gửi
              </button>
            )}
          </div>
        </div>
      </div>

      <details className="card cli-api">
        <summary className="card-head">
          <h3>
            <Icon name="book" size={15} /> Gọi agy CLI từ script ngoài
          </h3>
          <span className="hint">POST /api/agy-cli/chat</span>
        </summary>
        <div className="card-body">
          <div className="agy-snippet-head">
            <strong>Lệnh mẫu</strong>
            <button className="btn btn-light btn-sm" type="button" onClick={() => copyText(apiExample, toast)}>
              <Icon name="copy" size={13} /> Chép
            </button>
          </div>
          <pre className="agy-out small">{apiExample}</pre>
        </div>
      </details>
    </div>
  );
}
