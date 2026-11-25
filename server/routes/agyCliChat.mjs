/**
 * API tách biệt kết nối trực tiếp với `agy` CLI (độc lập hoàn toàn với luồng reup/dub video).
 * Cho phép gửi lệnh / trò chuyện nhiều lượt qua HTTP JSON hoặc SSE Streaming,
 * hỗ trợ để `agy` CLI tự đọc/sửa mã nguồn và chạy lệnh trong thư mục dự án chỉ định.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT } from "../config.mjs";

const activeRuns = new Map(); // runId -> { child, cwd, startedAt }

function resolveAgyBin() {
  const local = path.join(os.homedir(), ".local", "bin", "agy");
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (fs.existsSync(local)) return local;
  return "agy";
}

function killRun(runId) {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  activeRuns.delete(runId);
  try {
    if (entry.child?.pid) {
      // Kill whole process group because we spawn with detached: true
      process.kill(-entry.child.pid, "SIGTERM");
    }
  } catch {
    try {
      entry.child?.kill("SIGTERM");
    } catch {}
  }
  return true;
}

function buildAgyArgs({ message, model, effort, mode, conversationId }) {
  const args = ["-p", message, "--output-format", "stream-json"];

  if (conversationId && typeof conversationId === "string" && conversationId.trim()) {
    args.push("--conversation", conversationId.trim());
  }
  if (model && typeof model === "string" && model.trim()) {
    args.push("--model", model.trim());
  } else if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    args.push("--effort", effort);
  }

  if (mode === "full-auto") {
    args.push("--dangerously-skip-permissions");
  } else if (mode === "plan" || mode === "accept-edits" || mode === "auto") {
    args.push("--mode", mode);
  } else {
    args.push("--mode", "accept-edits");
  }

  return args;
}

function parseStepSummary(su) {
  const stepType = su.step_type || "";
  if (!stepType || stepType === "user_input" || stepType === "agent_response") return null;
  // Try pulling a short hint from tool payload if present
  const detail =
    su.tool_name ||
    su.command ||
    su.path ||
    su.summary ||
    su.title ||
    "";
  return {
    stepIndex: su.step_index,
    stepType,
    state: su.state || "ACTIVE",
    detail: detail ? String(detail).slice(0, 160) : "",
    durationSeconds: su.duration_seconds ?? null,
  };
}

export default async function agyCliChatRoutes(app) {
  app.addHook("onClose", async () => {
    for (const id of [...activeRuns.keys()]) killRun(id);
  });

  app.get("/api/agy-cli/status", async () => {
    const bin = resolveAgyBin();
    const available = bin === "agy" ? true : fs.existsSync(bin);
    return {
      ok: true,
      available,
      binary: bin,
      defaultCwd: ROOT,
      activeRuns: [...activeRuns.entries()].map(([id, r]) => ({
        runId: id,
        cwd: r.cwd,
        startedAt: r.startedAt,
      })),
    };
  });

  app.post("/api/agy-cli/abort", async (req, reply) => {
    const runId = String(req.body?.runId || "").trim();
    if (!runId) return reply.code(400).send({ ok: false, error: "Thiếu runId" });
    const killed = killRun(runId);
    return { ok: true, killed };
  });

  /**
   * POST /api/agy-cli/chat
   * Body: { message, cwd?, model?, effort?, mode?, conversationId?, stream? }
   * - stream: true  -> Server-Sent Events (init / delta / tool / result / error / done)
   * - stream: false -> JSON { ok, runId, conversationId, response, toolsUsed, durationSeconds, usage, cwd }
   */
  app.post("/api/agy-cli/chat", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const message = String(body.message || body.prompt || "").trim();
    if (!message) {
      return reply.code(400).send({ ok: false, error: "Thiếu nội dung tin nhắn (`message`)" });
    }

    const cwd = path.resolve(String(body.cwd || ROOT).trim() || ROOT);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return reply.code(400).send({ ok: false, error: `Thư mục làm việc không tồn tại: ${cwd}` });
    }

    const mode = ["plan", "accept-edits", "auto", "full-auto"].includes(body.mode)
      ? body.mode
      : "accept-edits";
    const wantStream = body.stream === true;
    const runId = `cli_${crypto.randomBytes(6).toString("hex")}`;
    const bin = resolveAgyBin();
    const args = buildAgyArgs({
      message,
      model: body.model,
      effort: body.effort,
      mode,
      conversationId: body.conversationId,
    });

    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeRuns.set(runId, { child, cwd, startedAt: Date.now() });

    // ─── Streaming SSE mode (Web UI & real-time clients) ───────────────────
    if (wantStream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvt = (payload) => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      sendEvt({ type: "start", runId, cwd, mode });

      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) {
          killRun(runId);
        }
      });

      let buf = "";
      let stderrText = "";
      let gotResult = false;
      let lastConversationId = body.conversationId || "";

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.event === "init") {
            lastConversationId = evt.conversation_id || lastConversationId;
            sendEvt({
              type: "init",
              conversationId: lastConversationId,
              cwd: evt.init?.cwd || cwd,
              permissionMode: evt.init?.permission_mode || mode,
            });
          } else if (evt.event === "step_update" && evt.step_update) {
            const su = evt.step_update;
            if (su.conversation_id) lastConversationId = su.conversation_id;
            if (su.step_type === "agent_response") {
              if (su.text_delta || su.thinking_delta) {
                sendEvt({
                  type: "delta",
                  text: su.text_delta || "",
                  thinking: su.thinking_delta || "",
                });
              }
            } else {
              const toolInfo = parseStepSummary(su);
              if (toolInfo) sendEvt({ type: "tool", ...toolInfo });
            }
          } else if (evt.event === "result" && evt.result) {
            gotResult = true;
            const r = evt.result;
            lastConversationId = r.conversation_id || lastConversationId;
            sendEvt({
              type: "result",
              conversationId: lastConversationId,
              status: r.status || "SUCCESS",
              response: r.response ?? "",
              durationSeconds: r.duration_seconds ?? null,
              numTurns: r.num_turns ?? 1,
              usage: r.usage || null,
            });
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        activeRuns.delete(runId);
        sendEvt({ type: "error", message: `Không chạy được agy CLI: ${err.message}` });
        sendEvt({ type: "done" });
        if (!reply.raw.writableEnded) reply.raw.end();
      });

      child.on("close", (code, sig) => {
        activeRuns.delete(runId);
        if (!gotResult && code !== 0) {
          sendEvt({
            type: "error",
            message:
              sig === "SIGTERM"
                ? "Đã dừng tiến trình agy CLI theo yêu cầu."
                : `agy CLI thoát với mã ${code}: ${stderrText.trim().slice(-400) || "Không rõ nguyên nhân"}`,
          });
        }
        sendEvt({ type: "done", conversationId: lastConversationId });
        if (!reply.raw.writableEnded) reply.raw.end();
      });
      return;
    }

    // ─── Non-streaming JSON API mode ───────────────────────────────────────
    return new Promise((resolve) => {
      let buf = "";
      let stderrText = "";
      let conversationId = body.conversationId || "";
      let responseText = "";
      let streamedText = "";
      let usage = null;
      let durationSeconds = null;
      const toolsUsed = [];

      const handleLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }
        if (evt.event === "init" && evt.conversation_id) {
          conversationId = evt.conversation_id;
        } else if (evt.event === "step_update" && evt.step_update) {
          const su = evt.step_update;
          if (su.conversation_id) conversationId = su.conversation_id;
          if (su.step_type === "agent_response" && su.text_delta) {
            streamedText += su.text_delta;
          } else if (su.state === "DONE") {
            const toolInfo = parseStepSummary(su);
            if (toolInfo) toolsUsed.push(toolInfo.stepType);
          }
        } else if (evt.event === "result" && evt.result) {
          conversationId = evt.result.conversation_id || conversationId;
          responseText = evt.result.response ?? "";
          usage = evt.result.usage || null;
          durationSeconds = evt.result.duration_seconds ?? null;
        }
      };

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) handleLine(l);
      });

      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        activeRuns.delete(runId);
        resolve(reply.code(500).send({ ok: false, error: `Không chạy được agy CLI: ${err.message}` }));
      });

      child.on("close", (code) => {
        activeRuns.delete(runId);
        if (buf.trim()) handleLine(buf);
        if (code !== 0 && !responseText && !streamedText) {
          resolve(
            reply.code(500).send({
              ok: false,
              error: `agy CLI lỗi (code ${code}): ${stderrText.trim().slice(-400) || "Không có phản hồi"}`,
            })
          );
          return;
        }
        resolve(
          reply.send({
            ok: true,
            runId,
            conversationId,
            response: responseText || streamedText,
            toolsUsed,
            durationSeconds,
            usage,
            cwd,
            mode,
          })
        );
      });
    });
  });
}
