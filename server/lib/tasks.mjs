/** Tiến trình nền: chạy 1 cái, các cái sau xếp hàng đợi. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { DATA_DIR, DOWNLOADS_DIR, PORT, ROOT, TASK_LOG } from "../config.mjs";
import { relOf } from "./util.mjs";
import { setVideoProject } from "./store.mjs";

export const task = {
  proc: null,
  type: "",
  target: "",
  progress: { pct: 0, label: "", eta: null, stage: 0 },
  logs: [],
  startedAt: 0,
  endedAt: 0,
  exitCode: null,
  lastType: "",
};
const MAX_LOG_LINES = 500;
// Hàng đợi: tác vụ bấm khi đang bận sẽ chờ ở đây, chạy lần lượt.
export const queue = [];
export const history = []; // các tác vụ đã xong gần đây, mới nhất trước
const MAX_QUEUE = 30;
const MAX_HISTORY = 15;
let queueSeq = 0;
// Mỗi tác vụ có 1 mã (task_id) trả về lúc gọi; "start"/"end" báo cho lớp gọi hàm (routes/functions.mjs) biết kết quả.
let taskSeq = 0;
export const taskEvents = new EventEmitter();

const DL_LINE = /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/;
// Dòng tiến độ của aria2c: [#4c3a6a 304MiB/787MiB(38%) CN:16 DL:10MiB ETA:44s]
const ARIA_LINE = /^\[#\w+ (\S+?)\/(\S+?)\((\d+)%\) CN:\d+(?: DL:(\S+?))?(?: ETA:(\S+?))?\]/;
const ARIA_NOISE = /^(\s*\*\*\* Download Progress Summary|[=-]{20,}|FILE: )/;
const LOG_TS = /^\[[^\]]*\] /;

/** "05:12" (yt-dlp) hoặc "1h2m3s" (aria2c) -> giây */
function etaToSec(s) {
  if (!s) return null;
  if (/^\d+(:\d+)*$/.test(s)) return s.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  const parts = [...s.matchAll(/(\d+)([hms])/g)];
  return parts.length ? parts.reduce((a, [, n, u]) => a + Number(n) * { h: 3600, m: 60, s: 1 }[u], 0) : null;
}

function appendLog(line) {
  const clean = String(line || "").replace(/\r/g, "").trimEnd();
  if (!clean) return;

  // Tiến độ có cấu trúc do dub_video.py / download_bilibili.mjs in ra — không đưa vào nhật ký.
  if (clean.startsWith("@@PROGRESS ")) {
    try {
      const p = JSON.parse(clean.slice(11));
      task.progress = { pct: Number(p.pct) || 0, label: String(p.label || ""), eta: p.eta ?? null, stage: p.stage || 0 };
    } catch {}
    return;
  }

  if (ARIA_NOISE.test(clean)) return;
  const aria = clean.match(ARIA_LINE);
  // đưa dòng aria2c về cùng dạng [%, tổng, tốc độ, ETA] với dòng [download] của yt-dlp
  const dl = aria ? [aria[0], aria[3], aria[2], aria[4] && `${aria[4]}/s`, aria[5]] : clean.match(DL_LINE);
  if (dl) {
    const extra = [dl[2] && `/ ${dl[2]}`, dl[3] && `· ${dl[3]}`].filter(Boolean).join(" ");
    task.progress = { pct: Math.min(99, Number(dl[1])), label: `Đang tải ${dl[1]}% ${extra}`.trim(), eta: etaToSec(dl[4]), stage: 0 };
  }
  const entry = `[${new Date().toLocaleTimeString("vi-VN", { hour12: false })}] ${clean}`;
  const last = task.logs.length - 1;
  // yt-dlp in hàng nghìn dòng %: ghi đè dòng % ngay trước để nhật ký không trôi mất thông tin hữu ích.
  if (dl && last >= 0 && /^\[(download\]\s+[\d.]+%|#\w+ )/.test(task.logs[last].replace(LOG_TS, ""))) {
    task.logs[last] = entry;
    return;
  }
  task.logs.push(entry);
  if (task.logs.length > MAX_LOG_LINES) task.logs = task.logs.slice(-MAX_LOG_LINES);
  fs.appendFile(TASK_LOG, entry + "\n", () => {});
}

/** Chạy ngay nếu rảnh, không thì xếp hàng. Trả {ok, queued?, position?} hoặc {ok:false, error}. */
export function spawnTask(type, cmd, args, target = "", projectId = "") {
  const taskId = ++taskSeq;
  if (!task.proc && !queue.length) return runTask({ taskId, type, cmd, args, target, projectId });
  // Đăng nhập Chrome cần người dùng thao tác ngay, không xếp hàng.
  if (type === "login_chrome") return { ok: false, error: "Đang có tiến trình khác chạy. Hãy chờ xong hoặc dừng trước." };
  const dup = (t) => t.type === type && t.target === target;
  if (target && ((task.proc && dup(task)) || queue.some(dup))) return { ok: false, error: "Tác vụ này đang chạy hoặc đã có trong hàng đợi." };
  if (queue.length >= MAX_QUEUE) return { ok: false, error: `Hàng đợi đã đầy (${MAX_QUEUE} tác vụ).` };
  queue.push({ id: ++queueSeq, taskId, type, cmd, args, target, projectId, addedAt: Date.now() });
  return { ok: true, queued: true, position: queue.length, task_id: taskId };
}

function runNext() {
  if (!task.proc && queue.length) runTask(queue.shift());
}

function runTask({ taskId = 0, type, cmd, args, target = "", projectId = "" }) {
  const savedFiles = [];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TASK_LOG, "");
  Object.assign(task, {
    type,
    target,
    logs: [],
    progress: { pct: 0, label: "Đang khởi chạy...", eta: null, stage: 0 },
    startedAt: Date.now(),
    endedAt: 0,
    exitCode: null,
    lastType: type,
  });
  const fmtArg = (a) => (/^https?:\/\//i.test(String(a)) ? String(a) : path.basename(String(a)));
  appendLog(`Bắt đầu: ${path.basename(cmd)} ${args.map(fmtArg).join(" ")}`);

  // detached = nhóm tiến trình riêng, để nút Dừng tắt được cả yt-dlp / ffmpeg / agy con cháu.
  const proc = spawn(cmd, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ":0",
      AGY_PROXY_URL: process.env.AGY_PROXY_URL || `http://127.0.0.1:${PORT}`,
    },
    detached: true,
  });
  task.proc = proc;
  taskEvents.emit("start", { task_id: taskId });

  const lineReader = () => {
    let carry = "";
    return (buf) => {
      const parts = (carry + buf.toString("utf8")).split(/\r?\n|\r/);
      carry = parts.pop() || "";
      parts.forEach(appendLog);
      // Script tải in "SAVED_FILE:::<đường dẫn>" cho mỗi file xong: gán luôn vào dự án đang mở lúc bấm tải.
      for (const line of parts) {
        if (!line.startsWith("SAVED_FILE:::")) continue;
        const full = path.resolve(ROOT, line.slice("SAVED_FILE:::".length).trim());
        if (!full.startsWith(DOWNLOADS_DIR + path.sep)) continue;
        if (!savedFiles.includes(full)) savedFiles.push(full);
        if (projectId) setVideoProject(relOf(full), projectId);
      }
    };
  };
  proc.stdout.on("data", lineReader());
  proc.stderr.on("data", lineReader());
  proc.on("error", (err) => appendLog(`Không khởi chạy được tiến trình: ${err.message}`));
  proc.on("close", (code) => {
    appendLog(`Tiến trình kết thúc (exit code: ${code}).`);
    task.proc = null;
    task.type = "";
    task.target = "";
    task.endedAt = Date.now();
    task.exitCode = code;
    history.unshift({ type, target, started_at: task.startedAt, ended_at: task.endedAt, exit_code: code });
    history.length = Math.min(history.length, MAX_HISTORY);
    setImmediate(runNext);
    taskEvents.emit("end", { task_id: taskId, type, target, exit_code: code, logs: [...task.logs], saved_files: savedFiles });
    task.progress =
      code === 0
        ? { pct: 100, label: "Hoàn tất", eta: null, stage: 0 }
        : { ...task.progress, eta: null, label: code === 130 || code === null ? "Đã dừng — tiến độ đã lưu" : `Lỗi (mã ${code})` };
  });
  return { ok: true, task_id: taskId };
}

function signalTask(sig) {
  if (!task.proc) return;
  try {
    process.kill(-task.proc.pid, sig);
  } catch {}
}

export function stopTask() {
  if (!task.proc) return;
  const proc = task.proc;
  signalTask("SIGINT");
  appendLog("Đã gửi tín hiệu dừng tiến trình.");
  // Tiến trình không chịu dừng sau 10 giây thì tắt hẳn.
  setTimeout(() => task.proc === proc && signalTask("SIGKILL"), 10_000).unref();
}

/** Tắt server: bỏ hàng đợi, dừng tác vụ đang chạy. */
export function shutdownTasks() {
  queue.length = 0;
  signalTask("SIGINT");
}

/** Đang lồng tiếng / xuất lại thì không cho xóa bản lồng tiếng hay cache — tiến trình đang ghi vào đó. */
export function dubBusyError() {
  return task.proc && task.type.startsWith("dub_") ? "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa." : "";
}

/** Dữ liệu trả cho giao diện (/api/task). */
export function taskSnapshot() {
  return {
    running: Boolean(task.proc),
    task_type: task.type,
    last_type: task.lastType,
    target: task.target,
    progress: task.progress,
    started_at: task.startedAt,
    ended_at: task.endedAt,
    exit_code: task.exitCode,
    logs: task.logs,
    queue: queue.map(({ id, type, target, addedAt }) => ({ id, type, target, added_at: addedAt })),
    history,
  };
}

export function removeQueued(id) {
  const i = queue.findIndex((q) => q.id === Number(id));
  if (i >= 0) {
    const [q] = queue.splice(i, 1);
    taskEvents.emit("end", { task_id: q.taskId, type: q.type, target: q.target, exit_code: null, logs: ["Đã bỏ khỏi hàng đợi trước khi chạy."], saved_files: [] });
  }
  return i >= 0;
}
