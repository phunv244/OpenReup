#!/usr/bin/env node
/**
 * OpenReup Studio — máy chủ web cục bộ + API.
 * Phục vụ giao diện, quản lý 1 tiến trình nền (quét / tải / xóa logo / lồng tiếng) và các file video.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_JSON = path.join(DATA_DIR, "videos.json");
const BILIBILI_JSON = path.join(DATA_DIR, "bilibili.json");
const DUBBED_JSON = path.join(DATA_DIR, "dubbed.json");
const DUB_PROJECTS_DIR = path.join(DATA_DIR, "dub_projects");
const DUB_WORK_DIR = path.join(DATA_DIR, "dub_work");
const STORY_PROJECTS_DIR = path.join(DATA_DIR, "projects");
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
const MEDIA_CACHE_JSON = path.join(DATA_DIR, "media_cache.json");
const TASK_LOG = path.join(DATA_DIR, "last_task.log");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const BILIBILI_DIR = path.join(DOWNLOADS_DIR, "bilibili");
const DUBBED_DIR = path.join(DOWNLOADS_DIR, "dubbed");
const VENV_PYTHON = path.join(__dirname, ".venv", "bin", "python");
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
const PORT = Number(process.env.PORT || 3456);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const DEFAULT_CHANNEL_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Ghi qua file tạm rồi đổi tên: server bị tắt giữa chừng cũng không làm hỏng file dữ liệu. */
function writeJson(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), "utf8");
  fs.renameSync(tmp, file);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

/** job_id chỉ gồm chữ/số/_/- : chặn "." và ".." (path.basename không chặn) trước khi dùng để xóa thư mục. */
function safeJobId(value) {
  const id = path.basename(String(value || ""));
  return /^[0-9A-Za-z_-]+$/.test(id) ? id : "";
}

/** Đang lồng tiếng / xuất lại thì không cho xóa bản lồng tiếng hay cache — tiến trình đang ghi vào đó. */
function dubBusyError() {
  return task.proc && task.type.startsWith("dub_") ? "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa." : "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8"); // không để ký tự tiếng Việt/Trung bị cắt đôi giữa 2 gói TCP
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/** Chỉ chấp nhận file nằm trong downloads/ (chống ../). Trả về đường dẫn tuyệt đối hoặc "". */
function resolveDownload(rel) {
  const resolved = path.resolve(__dirname, String(rel || ""));
  return resolved.startsWith(DOWNLOADS_DIR + path.sep) ? resolved : "";
}

/* ------------------------------------------------------------------ */
/* Tiến trình nền (mỗi lúc chỉ 1)                                      */
/* ------------------------------------------------------------------ */
const task = {
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

function spawnTask(type, cmd, args, target = "") {
  if (task.proc) {
    return { ok: false, error: `Đang có tiến trình khác chạy (${task.type}). Hãy dừng trước.` };
  }
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
  appendLog(`Bắt đầu: ${path.basename(cmd)} ${args.map((a) => path.basename(String(a))).join(" ")}`);

  // detached = nhóm tiến trình riêng, để nút Dừng tắt được cả yt-dlp / ffmpeg / agy con cháu.
  const proc = spawn(cmd, args, {
    cwd: __dirname,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
    detached: true,
  });
  task.proc = proc;

  const lineReader = () => {
    let carry = "";
    return (buf) => {
      const parts = (carry + buf.toString("utf8")).split(/\r?\n|\r/);
      carry = parts.pop() || "";
      parts.forEach(appendLog);
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
    task.progress =
      code === 0
        ? { pct: 100, label: "Hoàn tất", eta: null, stage: 0 }
        : { ...task.progress, eta: null, label: code === 130 || code === null ? "Đã dừng — tiến độ đã lưu" : `Lỗi (mã ${code})` };
  });
  return { ok: true };
}

function signalTask(sig) {
  if (!task.proc) return;
  try {
    process.kill(-task.proc.pid, sig);
  } catch {}
}

function stopTask() {
  if (!task.proc) return;
  const proc = task.proc;
  signalTask("SIGINT");
  appendLog("Đã gửi tín hiệu dừng tiến trình.");
  // Tiến trình không chịu dừng sau 10 giây thì tắt hẳn.
  setTimeout(() => task.proc === proc && signalTask("SIGKILL"), 10_000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    signalTask("SIGINT");
    process.exit(0);
  });
}

/* ------------------------------------------------------------------ */
/* Dữ liệu Douyin / Bilibili / bản lồng tiếng                          */
/* ------------------------------------------------------------------ */
function readVideosData() {
  if (!fs.existsSync(DATA_JSON)) {
    return {
      source: "none",
      updated_at: "",
      channel_meta: {
        channel_name: "楚新钓",
        douyin_id: "76602931608",
        channel_url: DEFAULT_CHANNEL_URL,
        total_works: "580",
      },
      total_collected: 0,
      videos: [],
    };
  }
  const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
  const downloadedFiles = fs.existsSync(DOWNLOADS_DIR)
    ? fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".mp4"))
    : [];
  for (const v of data.videos || []) {
    v.local_file = (v.aweme_id && downloadedFiles.find((f) => f.includes(String(v.aweme_id)))) || "";
  }
  return data;
}

function readDubbed() {
  return readJson(DUBBED_JSON, {}).videos || [];
}

function updateDubbed(mutate) {
  if (!fs.existsSync(DUBBED_JSON)) return;
  const d = readJson(DUBBED_JSON, { videos: [] });
  d.videos = mutate(d.videos || []) || d.videos;
  d.total = d.videos.length;
  writeJson(DUBBED_JSON, d);
}

function removeFromBiliIndex(fname) {
  if (!fs.existsSync(BILIBILI_JSON)) return;
  const d = readJson(BILIBILI_JSON, { videos: [] });
  d.videos = (d.videos || []).filter((v) => v.local_file !== fname);
  d.total = d.videos.length;
  d.updated_at = new Date().toISOString().slice(0, 19);
  writeJson(BILIBILI_JSON, d);
}

/** Xóa sạch 1 bản lồng tiếng: video, phụ đề, lời dịch và thư mục cache/checkpoint. */
function removeDubJob(jobId) {
  if (!jobId) return;
  for (const p of [
    path.join(DUBBED_DIR, `${jobId}.mp4`),
    path.join(DUBBED_DIR, `${jobId}.srt`),
    path.join(DUB_PROJECTS_DIR, `${jobId}.json`),
  ]) {
    fs.rmSync(p, { force: true });
  }
  fs.rmSync(path.join(DUB_WORK_DIR, jobId), { recursive: true, force: true });
  updateDubbed((vids) => vids.filter((v) => v.job_id !== jobId));
}

/** Trạng thái các job lồng tiếng theo file nguồn (để hiện "đang dở 43% — Tiếp tục"). */
function readDubJobs() {
  const byInput = new Map();
  if (!fs.existsSync(DUB_WORK_DIR)) return byInput;
  for (const dir of fs.readdirSync(DUB_WORK_DIR)) {
    const meta = readJson(path.join(DUB_WORK_DIR, dir, "meta.json"), null);
    if (!meta?.input_path || !meta.status) continue;
    let status = meta.status;
    // Ghi "running" nhưng không có tiến trình nào => lần trước bị tắt đột ngột, coi như đang dở.
    if (status === "running" && !(task.proc && task.type === "dub_video")) status = "stopped";
    byInput.set(meta.input_path, {
      job_id: meta.job_id || dir,
      status,
      pct: Number(meta.pct || 0),
      label: meta.label || "",
      error: meta.error || "",
      params: meta.params || {},
      updated_at: meta.updated_at || "",
    });
  }
  return byInput;
}

/* ------------------------------------------------------------------ */
/* Thông tin media + ảnh xem trước (không bắt trình duyệt mở file nhiều GB) */
/* ------------------------------------------------------------------ */
let mediaCache = null;
let mediaCacheDirty = false;

async function probeMedia(fullPath, st) {
  mediaCache ??= readJson(MEDIA_CACHE_JSON, {});
  const key = `${fullPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (mediaCache[key]) return mediaCache[key];
  let info = { duration_sec: 0, resolution: "" };
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration", "-of", "json", fullPath,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    info = {
      duration_sec: Math.round(Number(j.format?.duration || 0)),
      resolution: s.width && s.height ? `${s.width}x${s.height}` : "",
    };
  } catch {}
  mediaCache[key] = info;
  mediaCacheDirty = true;
  return info;
}

function flushMediaCache(liveKeys) {
  if (!mediaCacheDirty) return;
  for (const k of Object.keys(mediaCache)) if (!liveKeys.has(k)) delete mediaCache[k];
  writeJson(MEDIA_CACHE_JSON, mediaCache, 0);
  mediaCacheDirty = false;
}

let thumbQueue = Promise.resolve();

function ensureThumb(fullPath, st) {
  const key = crypto.createHash("sha1").update(`${fullPath}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex");
  const out = path.join(THUMBS_DIR, `${key}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  // Xếp hàng lần lượt: mở trang có 50 video cũng chỉ chạy 1 ffmpeg tại 1 thời điểm.
  const job = thumbQueue.then(async () => {
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const tmp = `${out}.tmp.jpg`;
    for (const ss of ["8", "0"]) {
      try {
        await execFileP("ffmpeg", ["-v", "error", "-y", "-ss", ss, "-i", fullPath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", tmp]);
        if (fs.existsSync(tmp)) {
          fs.renameSync(tmp, out);
          return out;
        }
      } catch {}
    }
    return "";
  });
  thumbQueue = job.catch(() => "");
  return job;
}

/* ------------------------------------------------------------------ */
/* Phụ đề của bản lồng tiếng: đọc phân trang (video 90 tiếng có >100k câu) */
/* ------------------------------------------------------------------ */
const dubProjCache = { file: "", mtime: 0, data: null };

function loadDubProject(jobId) {
  const file = path.join(DUB_PROJECTS_DIR, `${jobId}.json`);
  if (!jobId || !fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  if (dubProjCache.file !== file || dubProjCache.mtime !== mtime) {
    Object.assign(dubProjCache, { file, mtime, data: JSON.parse(fs.readFileSync(file, "utf8")) });
  }
  return dubProjCache.data;
}

function saveDubProject(jobId, proj) {
  writeJson(path.join(DUB_PROJECTS_DIR, `${jobId}.json`), proj, 0);
  dubProjCache.file = "";
}

/* ------------------------------------------------------------------ */
/* Phục vụ file                                                        */
/* ------------------------------------------------------------------ */
function serveFile(req, res, fullPath, contentType) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    // "bytes=a-b", "bytes=a-" hoặc "bytes=-n" (n byte cuối)
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });
    fs.createReadStream(fullPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
    fs.createReadStream(fullPath).pipe(res);
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const GET = req.method === "GET";
  const POST = req.method === "POST";

  try {
    if (GET && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    if (GET && pathname.startsWith("/assets/")) {
      const safeName = path.basename(decodeURIComponent(pathname.slice("/assets/".length)));
      const filePath = path.join(ASSETS_DIR, safeName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(safeName).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(fs.readFileSync(filePath));
      return;
    }

    /* ---------- Tiến trình ---------- */
    if (GET && pathname === "/api/task") {
      sendJson(res, 200, {
        running: Boolean(task.proc),
        task_type: task.type,
        last_type: task.lastType,
        target: task.target,
        progress: task.progress,
        started_at: task.startedAt,
        ended_at: task.endedAt,
        exit_code: task.exitCode,
        logs: task.logs,
      });
      return;
    }

    if (POST && pathname === "/api/task/stop") {
      stopTask();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (GET && pathname === "/api/system") {
      let freeGb = 0;
      let totalGb = 0;
      try {
        const st = fs.statfsSync(__dirname);
        freeGb = Number(((st.bavail * st.bsize) / 1024 ** 3).toFixed(1));
        totalGb = Number(((st.blocks * st.bsize) / 1024 ** 3).toFixed(1));
      } catch {}
      sendJson(res, 200, { free_gb: freeGb, total_gb: totalGb });
      return;
    }

    /* ---------- Douyin ---------- */
    if (GET && pathname === "/api/videos") {
      sendJson(res, 200, readVideosData());
      return;
    }

    if (POST && pathname === "/api/login") {
      const body = await readBody(req);
      const url = (body.url || DEFAULT_CHANNEL_URL).trim();
      const result = spawnTask("login_chrome", process.execPath, [path.join(__dirname, "login_chrome.mjs"), url]);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (POST && pathname === "/api/scan") {
      const body = await readBody(req);
      const url = (body.url || DEFAULT_CHANNEL_URL).trim();
      const args = [path.join(__dirname, "list_channel_web.mjs"), "--url", url];
      if (body.limit && Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      if (body.resume) args.push("--resume");
      const result = spawnTask("scan_web", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (POST && pathname === "/api/download") {
      const body = await readBody(req);
      const args = [path.join(__dirname, "download_videos.mjs")];
      if (body.ids) args.push("--ids", String(body.ids));
      if (body.episodes) args.push("--episodes", String(body.episodes));
      if (body.limit && Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      const result = spawnTask("download", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (POST && pathname === "/api/status") {
      const body = await readBody(req);
      if (!fs.existsSync(DATA_JSON)) {
        sendJson(res, 404, { ok: false, error: "Chưa có data/videos.json" });
        return;
      }
      const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
      const v = (data.videos || []).find((x) => (x.aweme_id || `${x.title}|${x.publish_date || ""}`) === body.key);
      if (v) {
        v.reup_status = body.status || "pending";
        writeJson(DATA_JSON, data);
      }
      sendJson(res, 200, { ok: Boolean(v) });
      return;
    }

    /* ---------- Bilibili / YouTube ---------- */
    if (GET && pathname === "/api/bilibili") {
      const videos = (readJson(BILIBILI_JSON, {}).videos || []).filter(
        (v) => v.local_file && fs.existsSync(path.join(BILIBILI_DIR, v.local_file))
      );
      sendJson(res, 200, { total: videos.length, videos });
      return;
    }

    if (POST && pathname === "/api/bilibili/download") {
      const body = await readBody(req);
      const url = (body.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        sendJson(res, 400, { ok: false, error: "Vui lòng nhập link Bilibili hoặc YouTube (bắt đầu bằng http)." });
        return;
      }
      const args = [path.join(__dirname, "download_bilibili.mjs"), "--url", url];
      if (body.playlist) args.push("--playlist");
      if (body.playlist_items) args.push("--playlist-items", String(body.playlist_items));
      if (body.section) args.push("--section", String(body.section));
      if (body.quality) args.push("--quality", String(body.quality));
      if (body.delogo) args.push("--delogo", String(body.delogo));
      if (body.perf) args.push("--perf", String(body.perf));
      const result = spawnTask("bilibili_download", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (POST && pathname === "/api/bilibili/delogo") {
      const body = await readBody(req);
      const safeName = path.basename(String(body.local_file || ""));
      if (!safeName) {
        sendJson(res, 400, { ok: false, error: "Thiếu tên file cần xóa logo." });
        return;
      }
      const args = [
        path.join(__dirname, "download_bilibili.mjs"),
        "--delogo-file", safeName,
        "--delogo", String(body.delogo || "top-right"),
        "--perf", String(body.perf || "balanced"),
      ];
      const result = spawnTask("bilibili_delogo", process.execPath, args, `downloads/bilibili/${safeName}`);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    /* ---------- Dự án truyện / phim ---------- */
    if (GET && pathname === "/api/projects") {
      fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
      const dubbed = readDubbed();
      const projects = [];
      for (const f of fs.readdirSync(STORY_PROJECTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        const p = readJson(path.join(STORY_PROJECTS_DIR, f), null);
        if (!p) continue;
        const vids = dubbed.filter((v) => v.project_id === p.id);
        projects.push({ ...p, video_count: vids.length, videos: vids });
      }
      projects.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
      sendJson(res, 200, { total: projects.length, projects });
      return;
    }

    if (POST && pathname === "/api/projects") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: "Vui lòng nhập tên dự án." });
        return;
      }
      fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
      const slugBase =
        name
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/đ/gi, "d")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 36) || `du-an-${Date.now()}`;
      let id = slugBase;
      let n = 2;
      while (fs.existsSync(path.join(STORY_PROJECTS_DIR, `${id}.json`))) {
        id = `${slugBase}-${n++}`;
      }
      const now = new Date().toISOString().slice(0, 19);
      const proj = {
        id,
        name,
        type: String(body.type || "Truyện / Hoạt hình"),
        style: String(body.style || "Tự nhiên, dễ nghe, đúng mạch truyện"),
        synopsis: String(body.synopsis || ""),
        characters: Array.isArray(body.characters) ? body.characters : [],
        glossary: Array.isArray(body.glossary) ? body.glossary : [],
        episode_notes: {},
        created_at: now,
        updated_at: now,
      };
      writeJson(path.join(STORY_PROJECTS_DIR, `${id}.json`), proj);
      sendJson(res, 200, { ok: true, project: proj });
      return;
    }

    if (POST && pathname === "/api/projects/save") {
      const body = await readBody(req);
      const id = path.basename(String(body.id || ""));
      const filePath = path.join(STORY_PROJECTS_DIR, `${id}.json`);
      if (!id || !fs.existsSync(filePath)) {
        sendJson(res, 404, { ok: false, error: "Không tìm thấy dự án." });
        return;
      }
      const old = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const updated = {
        ...old,
        name: body.name !== undefined ? String(body.name).trim() || old.name : old.name,
        type: body.type !== undefined ? String(body.type) : old.type,
        style: body.style !== undefined ? String(body.style) : old.style,
        synopsis: body.synopsis !== undefined ? String(body.synopsis) : old.synopsis,
        characters: Array.isArray(body.characters) ? body.characters : old.characters || [],
        glossary: Array.isArray(body.glossary) ? body.glossary : old.glossary || [],
        episode_notes: body.episode_notes && typeof body.episode_notes === "object" ? body.episode_notes : old.episode_notes || {},
        updated_at: new Date().toISOString().slice(0, 19),
      };
      writeJson(filePath, updated);
      sendJson(res, 200, { ok: true, project: updated });
      return;
    }

    if (POST && pathname === "/api/projects/delete") {
      const body = await readBody(req);
      const id = path.basename(String(body.id || ""));
      if (id) fs.rmSync(path.join(STORY_PROJECTS_DIR, `${id}.json`), { force: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- Video nguồn ---------- */
    if (GET && pathname === "/api/sources") {
      const jobs = readDubJobs();
      const sources = [];
      const liveKeys = new Set();
      for (const [dir, source, relBase] of [
        [BILIBILI_DIR, "bilibili", "downloads/bilibili"],
        [DOWNLOADS_DIR, "douyin", "downloads"],
      ]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(".mp4") || f.includes(".delogo_tmp")) continue;
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          const info = await probeMedia(full, st);
          liveKeys.add(`${full}|${st.size}|${Math.round(st.mtimeMs)}`);
          sources.push({
            source,
            rel_path: `${relBase}/${f}`,
            name: f,
            size_mb: Number((st.size / 1048576).toFixed(1)),
            mtime: Math.round(st.mtimeMs),
            ...info,
            job: jobs.get(full) || null,
          });
        }
      }
      flushMediaCache(liveKeys);
      sources.sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, { total: sources.length, sources });
      return;
    }

    if (GET && pathname === "/api/thumb") {
      const full = resolveDownload(urlObj.searchParams.get("rel"));
      const st = full && fs.existsSync(full) ? fs.statSync(full) : null;
      const thumb = st?.isFile() ? await ensureThumb(full, st) : "";
      if (!thumb) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=604800" });
      fs.createReadStream(thumb).pipe(res);
      return;
    }

    if (POST && pathname === "/api/source/delete") {
      const body = await readBody(req);
      const resolved = resolveDownload(body.rel_path);
      if (!resolved || resolved.startsWith(DUBBED_DIR + path.sep)) {
        sendJson(res, 400, { ok: false, error: "Đường dẫn file không hợp lệ." });
        return;
      }
      if (task.proc && task.target && path.resolve(__dirname, task.target) === resolved) {
        sendJson(res, 409, { ok: false, error: "Video này đang được xử lý. Hãy dừng tiến trình trước khi xóa." });
        return;
      }
      if (body.delete_dubbed && dubBusyError()) {
        sendJson(res, 409, { ok: false, error: dubBusyError() });
        return;
      }
      // Job lồng tiếng đang dở của file này cũng vô dụng khi file nguồn mất.
      const pending = readDubJobs().get(resolved);
      if (pending && pending.status !== "done") fs.rmSync(path.join(DUB_WORK_DIR, pending.job_id), { recursive: true, force: true });

      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) fs.unlinkSync(resolved);
      fs.rmSync(resolved.replace(/\.mp4$/i, ".info.json"), { force: true });
      removeFromBiliIndex(path.basename(resolved));
      if (body.delete_dubbed) removeDubJob(safeJobId(body.job_id));
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- Lồng tiếng ---------- */
    if (GET && pathname === "/api/dubbed") {
      const videos = readDubbed().filter((v) => v.mp4_file && fs.existsSync(path.join(DUBBED_DIR, v.mp4_file)));
      sendJson(res, 200, { total: videos.length, videos });
      return;
    }

    if (POST && pathname === "/api/dub/start") {
      const body = await readBody(req);
      const rel = String(body.rel_path || "");
      const resolved = resolveDownload(rel);
      if (!resolved || resolved.startsWith(DUBBED_DIR + path.sep) || !fs.existsSync(resolved)) {
        sendJson(res, 400, { ok: false, error: "File video nguồn không hợp lệ." });
        return;
      }
      if (!fs.existsSync(VENV_PYTHON)) {
        sendJson(res, 500, { ok: false, error: "Chưa cài môi trường Python (.venv). Xem mục Cài đặt trong README." });
        return;
      }
      const args = [
        "-u",
        path.join(__dirname, "dub_video.py"),
        "--input", resolved,
        "--speed", String(Number(body.speed) || 0.5),
        "--voice", String(body.voice || "vi-VN-NamMinhNeural"),
        "--model", String(body.model || "base"),
        "--bg-volume", String(Number(body.bg_volume ?? 0.05) || 0),
        "--delogo", String(body.delogo || "none"),
      ];
      if (body.burn_sub === false) args.push("--no-sub");
      if (body.project_id) args.push("--story-project", String(body.project_id));
      if (body.fresh) args.push("--fresh");
      const result = spawnTask("dub_video", VENV_PYTHON, args, rel);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (GET && pathname === "/api/dub/segments") {
      const jobId = safeJobId(urlObj.searchParams.get("id"));
      const proj = loadDubProject(jobId);
      if (!proj) {
        sendJson(res, 404, { ok: false, error: "Không tìm thấy dữ liệu phụ đề của bản lồng tiếng này." });
        return;
      }
      const all = (proj.segments || []).map((s, i) => (s.id ? s : { ...s, id: i + 1 }));
      const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();
      let list = all;
      if (urlObj.searchParams.get("only") === "empty") list = list.filter((s) => !s.vi);
      if (q) list = list.filter((s) => (s.vi || "").toLowerCase().includes(q) || (s.zh || "").includes(q));
      const offset = Math.max(0, Number(urlObj.searchParams.get("offset")) || 0);
      const limit = Math.min(500, Math.max(1, Number(urlObj.searchParams.get("limit")) || 100));
      const { segments, ...info } = proj;
      sendJson(res, 200, {
        ...info,
        total: all.length,
        empty: all.reduce((a, s) => a + (s.vi ? 0 : 1), 0),
        matched: list.length,
        offset,
        items: list.slice(offset, offset + limit),
      });
      return;
    }

    if (POST && pathname === "/api/dub/rerender") {
      const body = await readBody(req);
      const jobId = safeJobId(body.job_id);
      const proj = loadDubProject(jobId);
      if (!proj) {
        sendJson(res, 404, { ok: false, error: "Không tìm thấy project để xuất lại." });
        return;
      }
      if (task.proc) {
        sendJson(res, 409, { ok: false, error: `Đang có tiến trình khác chạy (${task.type}). Hãy dừng trước.` });
        return;
      }
      // Chỉ nhận các câu đã sửa {id: lời mới} — không gửi lại cả trăm nghìn câu.
      const edits = body.edits && typeof body.edits === "object" ? body.edits : {};
      (proj.segments || []).forEach((s, i) => {
        const id = String(s.id ?? i + 1);
        if (id in edits) s.vi = String(edits[id]).trim();
      });
      if (body.voice) proj.voice = String(body.voice);
      if (body.bg_volume !== undefined) proj.bg_volume = Number(body.bg_volume) || 0;
      if (body.burn_sub !== undefined) proj.burn_sub = Boolean(body.burn_sub);
      if (body.delogo !== undefined) proj.delogo = String(body.delogo);
      saveDubProject(jobId, proj);

      const args = ["-u", path.join(__dirname, "dub_video.py"), "--project", jobId];
      const result = spawnTask("dub_rerender", VENV_PYTHON, args, jobId);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (POST && pathname === "/api/dub/assign") {
      const body = await readBody(req);
      const jobId = safeJobId(body.job_id);
      const projectId = String(body.project_id || "").trim();
      updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.project_id = projectId)));
      const proj = loadDubProject(jobId);
      if (proj) {
        proj.project_id = projectId;
        saveDubProject(jobId, proj);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (POST && pathname === "/api/dub/clean") {
      // Xóa cache (giọng đọc + các phần video đã mã hóa) để lấy lại ổ cứng; bản lồng tiếng vẫn giữ nguyên.
      const body = await readBody(req);
      const jobId = safeJobId(body.job_id);
      if (dubBusyError()) {
        sendJson(res, 409, { ok: false, error: dubBusyError() });
        return;
      }
      if (jobId) fs.rmSync(path.join(DUB_WORK_DIR, jobId), { recursive: true, force: true });
      updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.cache_mb = 0)));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (POST && pathname === "/api/dub/delete") {
      const body = await readBody(req);
      const jobId = safeJobId(body.job_id);
      if (!jobId) {
        sendJson(res, 400, { ok: false, error: "Thiếu job_id." });
        return;
      }
      if (dubBusyError()) {
        sendJson(res, 409, { ok: false, error: dubBusyError() });
        return;
      }
      removeDubJob(jobId);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- File tải về ---------- */
    if (GET && pathname.startsWith("/downloads/")) {
      const rest = decodeURIComponent(pathname.slice("/downloads/".length));
      const sub = rest.startsWith("dubbed/") ? DUBBED_DIR : rest.startsWith("bilibili/") ? BILIBILI_DIR : DOWNLOADS_DIR;
      const fname = path.basename(rest);
      serveFile(req, res, path.join(sub, fname), fname.endsWith(".srt") ? "text/plain; charset=utf-8" : "video/mp4");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenReup Studio đang chạy tại: http://localhost:${PORT}`);
});
