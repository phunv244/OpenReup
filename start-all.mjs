#!/usr/bin/env node
/**
 * Khởi động toàn bộ hệ thống bằng 1 lệnh duy nhất:
 *   1. AGY Multi-Account Proxy (cổng mặc định 3457)
 *   2. OpenReup Studio Server  (cổng mặc định 3456)
 *
 * Dùng:
 *   npm run start:all
 *   hoặc: node start-all.mjs
 *   hoặc: PORT=3456 AGY_PORT=3457 node start-all.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_PORT = process.env.PORT || "3456";
const AGY_PORT = process.env.AGY_PORT || "3457";

const services = [
  {
    name: "AGY-PROXY",
    color: "\x1b[33m", // yellow
    script: path.join(__dirname, "agy-proxy", "server.mjs"),
    env: { ...process.env, PORT: AGY_PORT },
  },
  {
    name: "OPENREUP ",
    color: "\x1b[36m", // cyan
    script: path.join(__dirname, "server.mjs"),
    env: {
      ...process.env,
      PORT: STUDIO_PORT,
      AGY_PROXY_URL: `http://127.0.0.1:${AGY_PORT}`,
    },
  },
];

const RESET = "\x1b[0m";
const children = [];
let shuttingDown = false;

function pipeWithPrefix(stream, label, color, target) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      target.write(`${color}[${label}]${RESET} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buf) target.write(`${color}[${label}]${RESET} ${buf}\n`);
  });
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 Đang dừng toàn bộ hệ thống (${signal})...`);
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
  // Chờ tiến trình con tự dọn (dừng ffmpeg, đóng stream); quá 5 giây mới ép tắt để không bỏ lại tiến trình mồ côi.
  const alive = () => children.filter((c) => c.exitCode === null && c.signalCode === null);
  const done = () => process.exit(process.exitCode || 0);
  for (const c of alive()) c.once("exit", () => alive().length || done());
  if (!alive().length) return done();
  setTimeout(() => {
    for (const c of alive()) c.kill("SIGKILL");
    done();
  }, 5000).unref();
}

console.log("🚀 Đang khởi động toàn bộ hệ thống...");
console.log(`   • OpenReup Studio : http://localhost:${STUDIO_PORT}`);
console.log(`   • AGY Proxy + UI  : http://localhost:${AGY_PORT}`);
console.log(`   • AGY OpenAI API  : http://localhost:${AGY_PORT}/v1/chat/completions`);
console.log("   (Nhấn Ctrl+C để dừng đồng thời cả 2 dịch vụ)\n");

for (const svc of services) {
  const child = spawn(process.execPath, [svc.script], {
    cwd: __dirname,
    env: svc.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  pipeWithPrefix(child.stdout, svc.name, svc.color, process.stdout);
  pipeWithPrefix(child.stderr, svc.name, svc.color, process.stderr);

  child.on("exit", (code, sig) => {
    if (!shuttingDown) {
      console.error(
        `\n⚠️  [${svc.name.trim()}] đã dừng đột ngột (code=${code}, signal=${sig || "none"}). Đang dừng tiến trình còn lại...`
      );
      process.exitCode = code || 1;
      shutdown("CHILD_EXIT");
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
