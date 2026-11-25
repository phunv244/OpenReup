/** Douyin, Bilibili/YouTube và danh sách video nguồn trong downloads/. */
import fs from "node:fs";
import path from "node:path";
import {
  BILIBILI_DIR, BILIBILI_JSON, DATA_JSON, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR, DUBBED_DIR, DUB_WORK_DIR, ROOT,
} from "../config.mjs";
import { ensureThumb, extractFrame, flushMediaCache, mediaKey, probeMedia } from "../lib/media.mjs";
import {
  readDubJobs, readVideoProjects, readVideosData, removeDubJob, removeFromBiliIndex, setVideoProject,
} from "../lib/store.mjs";
import { dubBusyError, spawnTask, task } from "../lib/tasks.mjs";
import {
  fail, projectFile, projectIdOf, readJson, relOf, resolveDownload, safeJobId, validDelogo, writeJson,
} from "../lib/util.mjs";

const NODE = process.execPath;
const script = (name) => path.join(ROOT, name);
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function sourceRoutes(app) {
  /* ---------- Douyin ---------- */
  app.get("/api/videos", async () => readVideosData());

  app.post("/api/login", async (req, reply) => {
    const url = String(req.body?.url || DEFAULT_CHANNEL_URL).trim();
    return send(reply, spawnTask("login_chrome", NODE, [script("login_chrome.mjs"), url]));
  });

  app.post("/api/scan", async (req, reply) => {
    const body = req.body || {};
    const args = [script("list_channel_web.mjs"), "--url", String(body.url || DEFAULT_CHANNEL_URL).trim()];
    if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
    if (body.resume) args.push("--resume");
    return send(reply, spawnTask("scan_web", NODE, args));
  });

  app.post("/api/download", async (req, reply) => {
    const body = req.body || {};
    const args = [script("download_videos.mjs")];
    if (body.ids) args.push("--ids", String(body.ids));
    if (body.episodes) args.push("--episodes", String(body.episodes));
    if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
    return send(reply, spawnTask("download", NODE, args, "", projectIdOf(body)));
  });

  app.post("/api/status", async (req, reply) => {
    const body = req.body || {};
    if (!fs.existsSync(DATA_JSON)) return fail(reply, 404, "Chưa có data/videos.json");
    const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
    const v = (data.videos || []).find((x) => (x.aweme_id || `${x.title}|${x.publish_date || ""}`) === body.key);
    if (v) {
      v.reup_status = body.status || "pending";
      writeJson(DATA_JSON, data);
    }
    return { ok: Boolean(v) };
  });

  /* ---------- Bilibili / YouTube ---------- */
  app.get("/api/bilibili", async () => {
    const videos = (readJson(BILIBILI_JSON, {}).videos || []).filter(
      (v) => v.local_file && fs.existsSync(path.join(BILIBILI_DIR, v.local_file))
    );
    return { total: videos.length, videos };
  });

  app.post("/api/bilibili/download", async (req, reply) => {
    const body = req.body || {};
    const url = String(body.url || "")
      .trim()
      .replace(/^(https?:\/\/(?:www\.|m\.)?bilibili\.com)\/[a-z]{2}(?:-[a-z]{2})?\/(video\/)/i, "$1/$2");
    const delogo = String(body.delogo || "none");
    if (!validDelogo(delogo)) return fail(reply, 400, "Vị trí logo không hợp lệ.");
    if (!/^https?:\/\//i.test(url)) return fail(reply, 400, "Vui lòng nhập link Bilibili hoặc YouTube (bắt đầu bằng http).");
    const args = [script("download_bilibili.mjs"), "--url", url, "--delogo", delogo];
    if (body.playlist) args.push("--playlist");
    if (body.playlist_items) args.push("--playlist-items", String(body.playlist_items));
    if (body.section) args.push("--section", String(body.section));
    if (body.quality) args.push("--quality", String(body.quality));
    if (body.perf) args.push("--perf", String(body.perf));
    return send(reply, spawnTask("bilibili_download", NODE, args, "", projectIdOf(body)));
  });

  app.post("/api/bilibili/delogo", async (req, reply) => {
    const body = req.body || {};
    const safeName = path.basename(String(body.local_file || ""));
    if (!safeName) return fail(reply, 400, "Thiếu tên file cần xóa logo.");
    if (!validDelogo(body.delogo || "top-right")) return fail(reply, 400, "Vùng xóa logo không hợp lệ.");
    const args = [
      script("download_bilibili.mjs"),
      "--delogo-file", safeName,
      "--delogo", String(body.delogo || "top-right"),
      "--perf", String(body.perf || "balanced"),
    ];
    return send(reply, spawnTask("bilibili_delogo", NODE, args, `downloads/bilibili/${safeName}`));
  });

  /* ---------- Video nguồn ---------- */
  app.get("/api/sources", async () => {
    const jobs = readDubJobs();
    const owners = readVideoProjects();
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
        liveKeys.add(mediaKey(full, st));
        sources.push({
          source,
          rel_path: `${relBase}/${f}`,
          name: f,
          size_mb: Number((st.size / 1048576).toFixed(1)),
          mtime: Math.round(st.mtimeMs),
          ...info,
          project_id: owners[`${relBase}/${f}`] || "",
          job: jobs.get(full) || null,
        });
      }
    }
    flushMediaCache(liveKeys);
    sources.sort((a, b) => b.mtime - a.mtime);
    return { total: sources.length, sources };
  });

  app.get("/api/thumb", async (req, reply) => {
    const full = resolveDownload(req.query.rel);
    const st = full && fs.existsSync(full) ? fs.statSync(full) : null;
    const thumb = st?.isFile() ? await ensureThumb(full, st) : "";
    if (!thumb) return reply.code(404).send("Not found");
    return reply.type("image/jpeg").header("Cache-Control", "max-age=604800").send(fs.createReadStream(thumb));
  });

  app.get("/api/frame", async (req, reply) => {
    const full = resolveDownload(req.query.rel);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return reply.code(404).send("Not found");
    const img = await extractFrame(full);
    if (!img) return reply.code(500).send("Không trích được khung hình");
    return reply.type("image/jpeg").header("Cache-Control", "no-store").send(img);
  });

  app.post("/api/source/assign", async (req, reply) => {
    const body = req.body || {};
    const full = resolveDownload(body.rel_path);
    const pid = String(body.project_id || "");
    if (!full || full.startsWith(DUBBED_DIR + path.sep) || !fs.existsSync(full)) return fail(reply, 400, "Video không hợp lệ.");
    if (pid && !fs.existsSync(projectFile(pid))) return fail(reply, 404, "Không tìm thấy dự án.");
    setVideoProject(relOf(full), pid);
    return { ok: true };
  });

  app.post("/api/source/delete", async (req, reply) => {
    const body = req.body || {};
    const resolved = resolveDownload(body.rel_path);
    if (!resolved || resolved.startsWith(DUBBED_DIR + path.sep)) return fail(reply, 400, "Đường dẫn file không hợp lệ.");
    if (task.proc && task.target && path.resolve(ROOT, task.target) === resolved) {
      return fail(reply, 409, "Video này đang được xử lý. Hãy dừng tiến trình trước khi xóa.");
    }
    if (body.delete_dubbed && dubBusyError()) return fail(reply, 409, dubBusyError());
    // Job lồng tiếng đang dở của file này cũng vô dụng khi file nguồn mất.
    const pending = readDubJobs().get(resolved);
    if (pending && pending.status !== "done") fs.rmSync(path.join(DUB_WORK_DIR, pending.job_id), { recursive: true, force: true });

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) fs.unlinkSync(resolved);
    fs.rmSync(resolved.replace(/\.mp4$/i, ".info.json"), { force: true });
    removeFromBiliIndex(path.basename(resolved));
    setVideoProject(relOf(resolved), "");
    if (body.delete_dubbed) removeDubJob(safeJobId(body.job_id));
    return { ok: true };
  });
}
