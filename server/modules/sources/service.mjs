/** Nghiệp vụ video nguồn: quét/tải Douyin, tải Bilibili/YouTube, xóa logo, danh sách video đã tải, gán dự án, xóa. Lỗi do input: ném Error có statusCode. */
import path from "node:path";
import { BILIBILI_DIR, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR, ROOT } from "../../config.mjs";
import { ensureThumb, extractFrame, flushMediaCache, mediaKey, probeMedia } from "../../lib/media.mjs";
import { httpError, projectIdOf, relOf, resolveDownload, safeJobId, validDelogo } from "../../lib/util.mjs";
import { forgetVideoFiles, lookupDownload, videoSources, videoThumb } from "../../lib/videos.mjs";

const NODE = process.execPath;
const script = (name) => path.join(ROOT, name);

/** Chuẩn hóa link Bilibili có tiền tố ngôn ngữ (/vi/video/...) về /video/... */
/** rel_path của video nguồn được liệt kê: .mp4 nằm thẳng trong downloads/ (Douyin) hoặc downloads/bilibili/, không phải file tạm xóa logo. */
const LISTED_RE = /^downloads\/(bilibili\/)?[^/]+\.mp4$/;
const listed = (rel) => LISTED_RE.test(rel) && !rel.includes(".delogo_tmp");

const normalizeUrl = (url) =>
  String(url || "").trim().replace(/^(https?:\/\/(?:www\.|m\.)?bilibili\.com)\/[a-z]{2}(?:-[a-z]{2})?\/(video\/)/i, "$1/$2");

/**
 * repo: sourceRepo (repo.mjs); deps.dub / deps.project: service của module dub / project (ctx.get) hoặc bản giả trong test;
 * deps.tasks: { spawnTask, running } của lib/tasks (bộ chạy tác vụ nền dùng chung).
 */
export function createSourceService(repo, { dub, project, tasks }) {
  /** Chạy 1 script node làm tác vụ nền: trả {ok, task_id} hoặc {ok:false, error} (đang bận). */
  const run = (type, args, target = "", projectId = "") => tasks.spawnTask(type, NODE, args, target, projectId);

  /** Đường dẫn tuyệt đối của 1 video nguồn (rel "downloads/...") nếu là file có thật, không thì "". */
  const fileOf = (rel) => {
    const full = resolveDownload(rel);
    return full && repo.isFile(full) ? full : "";
  };

  return {
    /* ---------- Douyin ---------- */
    douyinVideos: () => repo.readDouyin(),
    login: (url) => run("login_chrome", [script("login_chrome.mjs"), String(url || DEFAULT_CHANNEL_URL).trim()]),
    scan(body) {
      const args = [script("list_channel_web.mjs"), "--url", String(body.url || DEFAULT_CHANNEL_URL).trim()];
      if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      if (body.resume) args.push("--resume");
      return run("scan_web", args);
    },
    downloadDouyin(body) {
      const args = [script("download_videos.mjs")];
      if (body.ids) args.push("--ids", String(body.ids));
      if (body.episodes) args.push("--episodes", String(body.episodes));
      if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      return run("download", args, "", projectIdOf(body));
    },
    /** Đánh dấu trạng thái reup của 1 video Douyin (key = aweme_id hoặc "title|publish_date"). */
    setDouyinStatus(key, status) {
      const data = repo.readDouyinRaw();
      if (!data) throw httpError(404, "Chưa có data/videos.json");
      const v = (data.videos || []).find((x) => (x.aweme_id || `${x.title}|${x.publish_date || ""}`) === key);
      if (v) {
        v.reup_status = status || "pending";
        repo.writeDouyin(data);
      }
      return { ok: Boolean(v) };
    },

    /* ---------- Bilibili / YouTube ---------- */
    listBilibili() {
      const videos = repo.listBilibili();
      return { total: videos.length, videos };
    },
    downloadBilibili(body) {
      const url = normalizeUrl(body.url);
      const delogo = String(body.delogo || "none");
      if (!validDelogo(delogo)) throw httpError(400, "Vị trí logo không hợp lệ.");
      if (!/^https?:\/\//i.test(url)) throw httpError(400, "Vui lòng nhập link Bilibili hoặc YouTube (bắt đầu bằng http).");
      const args = [script("download_bilibili.mjs"), "--url", url, "--delogo", delogo];
      if (body.playlist) args.push("--playlist");
      if (body.playlist_items) args.push("--playlist-items", String(body.playlist_items));
      if (body.section) args.push("--section", String(body.section));
      if (body.quality) args.push("--quality", String(body.quality));
      if (body.perf) args.push("--perf", String(body.perf));
      return run("bilibili_download", args, "", projectIdOf(body));
    },
    delogo(body) {
      const safeName = path.basename(String(body.local_file || ""));
      if (!safeName) throw httpError(400, "Thiếu tên file cần xóa logo.");
      if (!validDelogo(body.delogo || "top-right")) throw httpError(400, "Vùng xóa logo không hợp lệ.");
      const args = [script("download_bilibili.mjs"), "--delogo-file", safeName, "--delogo", String(body.delogo || "top-right"), "--perf", String(body.perf || "balanced")];
      return run("bilibili_delogo", args, relOf(path.join(BILIBILI_DIR, safeName)));
    },

    /* ---------- Video nguồn đã tải ---------- */
    /**
     * Video nguồn ở cả hai bố cục: data/videos/<key>/source/ (qua chỉ mục video.json) và downloads/ cũ.
     * rel_path luôn dạng "downloads/...". File cũ có rel_path đã nằm trong chỉ mục thì bỏ (chỉ mục được ưu tiên như lookupDownload).
     */
    async list() {
      const jobs = dub.jobsBySource();
      const owners = project.videoOwners();
      const sources = [];
      const liveKeys = new Set();
      const add = async (rel, full, st) => {
        const info = await probeMedia(rel, full, st);
        liveKeys.add(mediaKey(rel, st));
        sources.push({
          source: rel.startsWith("downloads/bilibili/") ? "bilibili" : "douyin",
          rel_path: rel,
          name: path.posix.basename(rel),
          size_mb: Number((st.size / 1048576).toFixed(1)),
          mtime: Math.round(st.mtimeMs),
          ...info,
          project_id: owners[rel] || "",
          job: jobs.get(rel) || null,
        });
      };
      const indexed = new Set();
      for (const { rel, abs } of videoSources()) {
        indexed.add(rel);
        const st = abs && listed(rel) && repo.statFile(abs);
        if (st) await add(rel, abs, st);
      }
      for (const dir of [BILIBILI_DIR, DOWNLOADS_DIR]) {
        for (const { full, st } of repo.listMp4(dir)) {
          const rel = relOf(full);
          if (!indexed.has(rel)) await add(rel, full, st);
        }
      }
      flushMediaCache(liveKeys);
      sources.sort((a, b) => b.mtime - a.mtime);
      return { total: sources.length, sources };
    },
    fileOf,
    /**
     * Ảnh thu nhỏ của 1 video nguồn: thumb.jpg trong thư mục video (bố cục mới) nếu có, không thì jpg tạo 1 lần trong
     * data/thumbs/ rồi dùng lại. "" nếu không phải video nguồn hoặc không tạo được.
     */
    async thumb(rel) {
      const hit = lookupDownload(rel);
      if (hit?.kind !== "source" || !repo.isFile(hit.abs)) return "";
      return videoThumb(hit.key) || ensureThumb(relOf(hit.abs), hit.abs, repo.stat(hit.abs));
    },
    /** 1 khung hình jpg (Buffer) của video nguồn để chọn vùng logo / phụ đề. 404 nếu không phải video nguồn, 500 nếu ffmpeg không trích được. */
    async frame(rel) {
      const full = fileOf(rel);
      if (!full) throw httpError(404, "Không tìm thấy video.");
      const img = await extractFrame(full);
      if (!img) throw httpError(500, "Không trích được khung hình");
      return img;
    },
    /** Gán video nguồn vào dự án ("" = bỏ gán). Đang thuộc dự án khác thì 409, trừ khi move = true (chuyển có chủ đích). */
    assign(rel, projectId, move = false) {
      const hit = lookupDownload(rel);
      const full = hit?.kind === "source" ? hit.abs : "";
      const pid = String(projectId || "");
      if (!full || !repo.isFile(full)) throw httpError(400, "Video không hợp lệ.");
      if (pid && !project.exists(pid)) throw httpError(404, "Không tìm thấy dự án.");
      project.assignVideo(relOf(full), pid, { move });
      return { ok: true };
    },
    /** Xóa 1 video nguồn (+ job lồng tiếng đang dở của nó; delete_dubbed: cả bản lồng tiếng job_id). */
    remove(body) {
      const hit = lookupDownload(body.rel_path);
      const resolved = hit?.kind === "source" ? hit.abs : "";
      if (!resolved) throw httpError(400, "Đường dẫn file không hợp lệ.");
      const rel = relOf(resolved);
      // Thư mục (vd downloads/bilibili) không phải video: chặn ở đây, không để rmSync ném EISDIR → 500.
      // File không còn trên đĩa vẫn cho xóa để dọn mục gán dự án/bilibili.json còn sót.
      if (repo.exists(resolved) && !repo.isFile(resolved)) throw httpError(400, "Đường dẫn không phải file video.");
      const running = tasks.running();
      if (running?.target && resolveDownload(running.target) === resolved) {
        throw httpError(409, "Video này đang được xử lý. Hãy dừng tiến trình trước khi xóa.");
      }
      if (body.delete_dubbed && dub.busyError()) throw httpError(409, dub.busyError());
      // Job lồng tiếng đang dở của file này cũng vô dụng khi file nguồn mất.
      const pending = dub.jobsBySource().get(rel);
      if (pending && pending.status !== "done") dub.removeWorkDir(safeJobId(pending.job_id));

      repo.removeVideo(resolved);
      // Bố cục mới: bỏ file đã xóa khỏi video.json (thư mục video, job của nó giữ nguyên).
      if (hit.key) forgetVideoFiles(hit.key, repo.videoFiles(resolved));
      repo.removeFromBiliIndex(path.posix.basename(rel));
      project.unassignVideo(rel);
      if (body.delete_dubbed) dub.removeJob(safeJobId(body.job_id));
      return { ok: true };
    },
  };
}
