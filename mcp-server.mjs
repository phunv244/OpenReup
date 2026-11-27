#!/usr/bin/env node
/**
 * MCP server (stdio) cho OpenReup Studio: đưa các hàm ở /api/functions thành tool cho Claude Code, agy CLI...
 * Chỉ là cầu nối: mọi việc do server Studio làm, nên Studio phải đang chạy (npm start).
 *   Cấu hình client:  { "command": "node", "args": ["<đường dẫn>/mcp-server.mjs"], "env": { "OPENREUP_URL": "http://127.0.0.1:3456" } }
 */
import readline from "node:readline";

const BASE = (process.env.OPENREUP_URL || `http://127.0.0.1:${process.env.PORT || 3456}`).replace(/\/$/, "");

async function api(pathname, body) {
  let res;
  try {
    res = await fetch(BASE + pathname, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch (e) {
    throw new Error(`Không kết nối được OpenReup Studio tại ${BASE} (${e.cause?.message || e.message}). Hãy chạy "npm start" trước.`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenReup Studio trả về dữ liệu không phải JSON (HTTP ${res.status}): ${text}`);
  }
}

const handlers = {
  initialize: async (p) => ({
    protocolVersion: p?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "openreup", version: "1.0.0" },
  }),
  ping: async () => ({}),
  "tools/list": async () => ({
    tools: (await api("/api/functions")).functions.map(({ function: f }) => ({ name: f.name, description: f.description, inputSchema: f.parameters })),
  }),
  "tools/call": async (p) => {
    const out = await api("/api/functions/call", { name: p?.name, arguments: p?.arguments || {} });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: out.ok === false };
  },
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (req.id === undefined) return; // notification (vd notifications/initialized): không trả lời
  const handler = handlers[req.method];
  if (!handler) return send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  try {
    send({ id: req.id, result: await handler(req.params) });
  } catch (e) {
    // Lỗi của tool trả về dạng kết quả isError để model đọc được nguyên văn thông báo.
    if (req.method === "tools/call") send({ id: req.id, result: { content: [{ type: "text", text: e.message }], isError: true } });
    else send({ id: req.id, error: { code: -32603, message: e.message } });
  }
});
