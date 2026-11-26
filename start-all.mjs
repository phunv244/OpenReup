#!/usr/bin/env node
/**
 * Khởi động OpenReup Studio Server (cổng mặc định 3456).
 *
 * Dùng:
 *   npm run start:all
 *   hoặc: node start-all.mjs
 *   hoặc: PORT=3456 node start-all.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_PORT = process.env.PORT || "3456";

const services = [
  {
    name: "OPENREUP ",
    color: "\x1b[36m", // cyan
    script: path.join(__dirname, "server.mjs"),
    env: { ...process.env, PORT: STUDIO_PORT },
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

console.log("🚀 Đang khởi động OpenReup Studio...");
console.log(`   • OpenReup Studio : http://localhost:${STUDIO_PORT}`);
console.log("   (Nhấn Ctrl+C để dừng)\n");

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
