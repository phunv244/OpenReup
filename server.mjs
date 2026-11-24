#!/usr/bin/env node
/**
 * Local Web Server & API for Douyin Reup Manager
 * Serves the web UI + APIs to scan Douyin channels, download MP4s, preview videos, and track reup status.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_JSON = path.join(__dirname, "data", "videos.json");
const BILIBILI_JSON = path.join(__dirname, "data", "bilibili.json");
const DUBBED_JSON = path.join(__dirname, "data", "dubbed.json");
const DUB_PROJECTS_DIR = path.join(__dirname, "data", "dub_projects");
const STORY_PROJECTS_DIR = path.join(__dirname, "data", "projects");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const BILIBILI_DIR = path.join(__dirname, "downloads", "bilibili");
const DUBBED_DIR = path.join(__dirname, "downloads", "dubbed");
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

let activeProc = null;
let activeTaskType = "";
let activeTarget = "";
let taskProgress = { pct: 0, label: "" };
let taskLogs = [];

function parseProgressFromLine(line) {
  if (line.includes("[1/5]")) return { pct: 15, label: "Bước 1/5: Làm chậm âm thanh 0.5x..." };
  if (line.includes("[2/5]")) return { pct: 35, label: "Bước 2/5: Đang tách lời thoại tiếng Trung..." };
  if (line.includes("[3/5]")) return { pct: 60, label: "Bước 3/5: Antigravity AI đang dịch theo ngữ cảnh..." };
  if (line.includes("[4/5]")) return { pct: 80, label: "Bước 4/5: Đang tạo giọng đọc tiếng Việt..." };
  if (line.includes("[5/5]")) return { pct: 92, label: "Bước 5/5: Đang ghép video tốc độ gốc 1.0x..." };
  if (line.includes("[HOÀN TẤT]")) return { pct: 100, label: "Hoàn tất!" };
  if (line.includes("[Delogo] Đang xóa")) return { pct: 55, label: "Đang xóa logo bằng FFmpeg..." };
  if (line.includes("[Delogo] Xóa logo hoàn tất")) return { pct: 95, label: "Xóa logo hoàn tất!" };
  const dlMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (dlMatch) return { pct: Math.min(95, Math.round(Number(dlMatch[1]))), label: `Đang tải video (${dlMatch[1]}%)...` };
  return null;
}

function appendLog(line) {
  const clean = String(line || "").replace(/\r/g, "").trimEnd();
  if (!clean) return;
  const p = parseProgressFromLine(clean);
  if (p) taskProgress = p;
  const ts = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  taskLogs.push(`[${ts}] ${clean}`);
  if (taskLogs.length > 200) taskLogs = taskLogs.slice(-200);
}

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
    if (v.aweme_id) {
      const match = downloadedFiles.find((f) => f.includes(String(v.aweme_id)));
      v.local_file = match || "";
    } else {
      v.local_file = "";
    }
  }
  return data;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
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

function spawnTask(type, cmd, args, extraEnv = {}, target = "") {
  if (activeProc) {
    return { ok: false, error: `Đang có tiến trình khác chạy (${activeTaskType}). Hãy dừng trước.` };
  }
  taskLogs = [];
  activeTaskType = type;
  activeTarget = target;
  taskProgress = { pct: 8, label: "Đang khởi chạy..." };
  appendLog(`Bắt đầu: ${cmd} ${args.join(" ")}`);

  const proc = spawn(cmd, args, {
    cwd: __dirname,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0", ...extraEnv },
  });
  activeProc = proc;

  const onData = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim()) appendLog(line);
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("close", (code) => {
    appendLog(`Tiến trình kết thúc (exit code: ${code}).`);
    activeProc = null;
    activeTaskType = "";
    activeTarget = "";
    taskProgress = code === 0 ? { pct: 100, label: "Hoàn tất!" } : { pct: 0, label: `Lỗi (mã ${code})` };
  });
  return { ok: true };
}

function serveMp4(req, res, filename, baseDir = DOWNLOADS_DIR) {
  const safeName = path.basename(decodeURIComponent(filename));
  const fullPath = path.join(baseDir, safeName);
  if (!fs.existsSync(fullPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const stat = fs.statSync(fullPath);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(fullPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(fullPath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/assets/")) {
      const safeName = path.basename(decodeURIComponent(pathname.slice("/assets/".length)));
      const filePath = path.join(ASSETS_DIR, safeName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(safeName).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(fs.readFileSync(filePath));
      return;
    }

    if (req.method === "GET" && pathname === "/api/videos") {
      sendJson(res, 200, readVideosData());
      return;
    }

    if (req.method === "GET" && pathname === "/api/task") {
      const data = readVideosData();
      sendJson(res, 200, {
        running: Boolean(activeProc),
        task_type: activeTaskType,
        target: activeTarget,
        progress: taskProgress,
        total_collected: data.total_collected || (data.videos || []).length,
        logs: taskLogs,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      const url = (body.url || DEFAULT_CHANNEL_URL).trim();
      const result = spawnTask("login_chrome", process.execPath, [
        path.join(__dirname, "login_chrome.mjs"),
        url,
      ]);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      const body = await readBody(req);
      const url = (body.url || DEFAULT_CHANNEL_URL).trim();
      const args = [path.join(__dirname, "list_channel_web.mjs"), "--url", url];
      if (body.limit && Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      if (body.resume) args.push("--resume");
      const result = spawnTask("scan_web", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/download") {
      const body = await readBody(req);
      const args = [path.join(__dirname, "download_videos.mjs")];
      if (body.ids) args.push("--ids", String(body.ids));
      if (body.episodes) args.push("--episodes", String(body.episodes));
      if (body.limit && Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      const result = spawnTask("download", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/task/stop") {
      if (activeProc) {
        activeProc.kill("SIGINT");
        appendLog("Đã gửi tín hiệu dừng tiến trình.");
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/status") {
      const body = await readBody(req);
      if (!fs.existsSync(DATA_JSON)) {
        sendJson(res, 404, { ok: false, error: "Chưa có data/videos.json" });
        return;
      }
      const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
      let updated = false;
      for (const v of data.videos || []) {
        const key = v.aweme_id || `${v.title}|${v.publish_date || ""}`;
        if (key === body.key) {
          v.reup_status = body.status || "pending";
          updated = true;
          break;
        }
      }
      if (updated) {
        fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2), "utf8");
      }
      sendJson(res, 200, { ok: updated });
      return;
    }

    if (req.method === "GET" && pathname === "/api/system") {
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

    if (req.method === "GET" && pathname === "/api/bilibili") {
      let videos = [];
      if (fs.existsSync(BILIBILI_JSON)) {
        try {
          videos = JSON.parse(fs.readFileSync(BILIBILI_JSON, "utf8")).videos || [];
        } catch {}
      }
      // Keep only files that still exist on disk
      videos = videos.filter((v) => v.local_file && fs.existsSync(path.join(BILIBILI_DIR, v.local_file)));
      sendJson(res, 200, { total: videos.length, videos });
      return;
    }

    if (req.method === "POST" && pathname === "/api/bilibili/download") {
      const body = await readBody(req);
      const url = (body.url || "").trim();
      if (!url) {
        sendJson(res, 400, { ok: false, error: "Vui lòng nhập link Bilibili hoặc YouTube." });
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

    if (req.method === "POST" && pathname === "/api/bilibili/delogo") {
      const body = await readBody(req);
      const safeName = path.basename(String(body.local_file || ""));
      if (!safeName) {
        sendJson(res, 400, { ok: false, error: "Thiếu tên file cần xóa logo." });
        return;
      }
      const args = [
        path.join(__dirname, "download_bilibili.mjs"),
        "--delogo-file",
        safeName,
        "--delogo",
        String(body.delogo || "top-right"),
        "--perf",
        String(body.perf || "balanced"),
      ];
      const result = spawnTask("bilibili_delogo", process.execPath, args);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/bilibili/delete") {
      const body = await readBody(req);
      const safeName = path.basename(String(body.local_file || ""));
      if (!safeName) {
        sendJson(res, 400, { ok: false, error: "Thiếu tên file cần xóa." });
        return;
      }
      const mp4Path = path.join(BILIBILI_DIR, safeName);
      const infoPath = mp4Path.replace(/\.mp4$/i, ".info.json");
      if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
      if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);

      if (fs.existsSync(BILIBILI_JSON)) {
        try {
          const data = JSON.parse(fs.readFileSync(BILIBILI_JSON, "utf8"));
          data.videos = (data.videos || []).filter((v) => v.local_file !== safeName);
          data.total = data.videos.length;
          data.updated_at = new Date().toISOString().slice(0, 19);
          fs.writeFileSync(BILIBILI_JSON, JSON.stringify(data, null, 2), "utf8");
        } catch {}
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
      let dubbed = [];
      if (fs.existsSync(DUBBED_JSON)) {
        try {
          dubbed = JSON.parse(fs.readFileSync(DUBBED_JSON, "utf8")).videos || [];
        } catch {}
      }
      const projects = [];
      for (const f of fs.readdirSync(STORY_PROJECTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        try {
          const p = JSON.parse(fs.readFileSync(path.join(STORY_PROJECTS_DIR, f), "utf8"));
          const vids = dubbed.filter((v) => v.project_id === p.id);
          projects.push({ ...p, video_count: vids.length, videos: vids });
        } catch {}
      }
      projects.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
      sendJson(res, 200, { total: projects.length, projects });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
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
          .replace(/[\u0300-\u036f]/g, "")
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
      fs.writeFileSync(path.join(STORY_PROJECTS_DIR, `${id}.json`), JSON.stringify(proj, null, 2), "utf8");
      sendJson(res, 200, { ok: true, project: proj });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/save") {
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
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
      sendJson(res, 200, { ok: true, project: updated });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects/delete") {
      const body = await readBody(req);
      const id = path.basename(String(body.id || ""));
      const filePath = path.join(STORY_PROJECTS_DIR, `${id}.json`);
      if (id && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/dub/assign") {
      const body = await readBody(req);
      const jobId = path.basename(String(body.job_id || ""));
      const projectId = String(body.project_id || "").trim();
      if (fs.existsSync(DUBBED_JSON)) {
        const d = JSON.parse(fs.readFileSync(DUBBED_JSON, "utf8"));
        for (const v of d.videos || []) {
          if (v.job_id === jobId) v.project_id = projectId;
        }
        fs.writeFileSync(DUBBED_JSON, JSON.stringify(d, null, 2), "utf8");
      }
      const projPath = path.join(DUB_PROJECTS_DIR, `${jobId}.json`);
      if (fs.existsSync(projPath)) {
        const p = JSON.parse(fs.readFileSync(projPath, "utf8"));
        p.project_id = projectId;
        fs.writeFileSync(projPath, JSON.stringify(p, null, 2), "utf8");
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/sources") {
      const sources = [];
      if (fs.existsSync(BILIBILI_DIR)) {
        for (const f of fs.readdirSync(BILIBILI_DIR)) {
          if (f.endsWith(".mp4") && !f.includes(".delogo_tmp")) {
            const st = fs.statSync(path.join(BILIBILI_DIR, f));
            sources.push({
              source: "bilibili",
              rel_path: `downloads/bilibili/${f}`,
              label: `[Bilibili] ${f} (${(st.size / 1048576).toFixed(1)} MB)`,
              mtime: st.mtimeMs,
            });
          }
        }
      }
      if (fs.existsSync(DOWNLOADS_DIR)) {
        for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
          if (f.endsWith(".mp4")) {
            const full = path.join(DOWNLOADS_DIR, f);
            if (fs.statSync(full).isFile()) {
              const st = fs.statSync(full);
              sources.push({
                source: "douyin",
                rel_path: `downloads/${f}`,
                label: `[Douyin] ${f} (${(st.size / 1048576).toFixed(1)} MB)`,
                mtime: st.mtimeMs,
              });
            }
          }
        }
      }
      sources.sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, { total: sources.length, sources });
      return;
    }

    if (req.method === "GET" && pathname === "/api/dubbed") {
      let videos = [];
      if (fs.existsSync(DUBBED_JSON)) {
        try {
          videos = JSON.parse(fs.readFileSync(DUBBED_JSON, "utf8")).videos || [];
        } catch {}
      }
      videos = videos.filter((v) => v.mp4_file && fs.existsSync(path.join(DUBBED_DIR, v.mp4_file)));
      sendJson(res, 200, { total: videos.length, videos });
      return;
    }

    if (req.method === "GET" && pathname === "/api/dub/project") {
      const id = path.basename(String(urlObj.searchParams.get("id") || ""));
      const projPath = path.join(DUB_PROJECTS_DIR, `${id}.json`);
      if (!id || !fs.existsSync(projPath)) {
        sendJson(res, 404, { ok: false, error: "Không tìm thấy dữ liệu phụ đề của bản lồng tiếng này." });
        return;
      }
      sendJson(res, 200, JSON.parse(fs.readFileSync(projPath, "utf8")));
      return;
    }

    if (req.method === "POST" && pathname === "/api/dub/start") {
      const body = await readBody(req);
      const rel = String(body.rel_path || "");
      const resolved = path.resolve(__dirname, rel);
      if (!rel || (!resolved.startsWith(DOWNLOADS_DIR + path.sep) && !resolved.startsWith(BILIBILI_DIR + path.sep)) || !fs.existsSync(resolved)) {
        sendJson(res, 400, { ok: false, error: "File video nguồn không hợp lệ." });
        return;
      }
      const args = [
        "-u",
        path.join(__dirname, "dub_video.py"),
        "--input",
        resolved,
        "--speed",
        String(body.speed || 0.5),
        "--voice",
        String(body.voice || "vi-VN-NamMinhNeural"),
        "--model",
        String(body.model || "base"),
        "--bg-volume",
        String(body.bg_volume ?? 0.05),
      ];
      if (body.burn_sub === false) args.push("--no-sub");
      if (body.project_id) args.push("--story-project", String(body.project_id));
      const result = spawnTask("dub_video", VENV_PYTHON, args, {}, rel);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/dub/rerender") {
      const body = await readBody(req);
      const jobId = path.basename(String(body.job_id || ""));
      const projPath = path.join(DUB_PROJECTS_DIR, `${jobId}.json`);
      if (!jobId || !fs.existsSync(projPath)) {
        sendJson(res, 404, { ok: false, error: "Không tìm thấy project để xuất lại." });
        return;
      }
      const proj = JSON.parse(fs.readFileSync(projPath, "utf8"));
      if (Array.isArray(body.segments)) proj.segments = body.segments;
      if (body.voice) proj.voice = String(body.voice);
      if (body.bg_volume !== undefined) proj.bg_volume = Number(body.bg_volume);
      if (body.burn_sub !== undefined) proj.burn_sub = Boolean(body.burn_sub);
      fs.writeFileSync(projPath, JSON.stringify(proj, null, 2), "utf8");

      const args = ["-u", path.join(__dirname, "dub_video.py"), "--project", jobId];
      const result = spawnTask("dub_rerender", VENV_PYTHON, args, {}, jobId);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/source/delete") {
      const body = await readBody(req);
      const rel = String(body.rel_path || "");
      const resolved = path.resolve(__dirname, rel);
      const inDownloads = resolved.startsWith(DOWNLOADS_DIR + path.sep);
      if (!rel || !inDownloads) {
        sendJson(res, 400, { ok: false, error: "Đường dẫn file không hợp lệ." });
        return;
      }

      const fname = path.basename(resolved);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        fs.unlinkSync(resolved);
      }
      const infoPath = resolved.replace(/\.mp4$/i, ".info.json");
      if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);

      // Update bilibili.json if present
      if (fs.existsSync(BILIBILI_JSON)) {
        try {
          const d = JSON.parse(fs.readFileSync(BILIBILI_JSON, "utf8"));
          d.videos = (d.videos || []).filter((v) => v.local_file !== fname);
          d.total = d.videos.length;
          d.updated_at = new Date().toISOString().slice(0, 19);
          fs.writeFileSync(BILIBILI_JSON, JSON.stringify(d, null, 2), "utf8");
        } catch {}
      }

      // Optionally also delete linked dubbed files
      const jobId = path.basename(String(body.job_id || ""));
      if (body.delete_dubbed && jobId) {
        for (const p of [
          path.join(DUBBED_DIR, `${jobId}.mp4`),
          path.join(DUBBED_DIR, `${jobId}.srt`),
          path.join(DUB_PROJECTS_DIR, `${jobId}.json`),
        ]) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (fs.existsSync(DUBBED_JSON)) {
          try {
            const d = JSON.parse(fs.readFileSync(DUBBED_JSON, "utf8"));
            d.videos = (d.videos || []).filter((v) => v.job_id !== jobId);
            d.total = d.videos.length;
            fs.writeFileSync(DUBBED_JSON, JSON.stringify(d, null, 2), "utf8");
          } catch {}
        }
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/dub/delete") {
      const body = await readBody(req);
      const jobId = path.basename(String(body.job_id || ""));
      if (!jobId) {
        sendJson(res, 400, { ok: false, error: "Thiếu job_id." });
        return;
      }
      for (const p of [
        path.join(DUBBED_DIR, `${jobId}.mp4`),
        path.join(DUBBED_DIR, `${jobId}.srt`),
        path.join(DUB_PROJECTS_DIR, `${jobId}.json`),
      ]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (fs.existsSync(DUBBED_JSON)) {
        try {
          const d = JSON.parse(fs.readFileSync(DUBBED_JSON, "utf8"));
          d.videos = (d.videos || []).filter((v) => v.job_id !== jobId);
          d.total = d.videos.length;
          fs.writeFileSync(DUBBED_JSON, JSON.stringify(d, null, 2), "utf8");
        } catch {}
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/downloads/dubbed/")) {
      const fname = path.basename(decodeURIComponent(pathname.slice("/downloads/dubbed/".length)));
      if (fname.endsWith(".srt")) {
        const srtPath = path.join(DUBBED_DIR, fname);
        if (!fs.existsSync(srtPath)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(fs.readFileSync(srtPath));
        return;
      }
      serveMp4(req, res, fname, DUBBED_DIR);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/downloads/bilibili/")) {
      serveMp4(req, res, pathname.slice("/downloads/bilibili/".length), BILIBILI_DIR);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/downloads/")) {
      serveMp4(req, res, pathname.slice("/downloads/".length), DOWNLOADS_DIR);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Douyin Reup Web UI đang chạy tại: http://localhost:${PORT}`);
});
