/** Nghiệp vụ video nguồn: quét/tải Douyin, tải Bilibili/YouTube, xóa logo, danh sách video đã tải, gán dự án, xóa. Lỗi do input: ném Error có statusCode. */
import path from "node:path";
import { BILIBILI_DIR, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR, DUBBED_DIR, ROOT } from "../../config.mjs";
import { flushMediaCache, mediaKey, probeMedia } from "../../lib/media.mjs";
import { projectIdOf, relOf, resolveDownload, safeJobId, validDelogo } from "../../lib/util.mjs";

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const NODE = process.execPath;
const script = (name) => path.join(ROOT, name);

/** Chuẩn hóa link Bilibili có tiền tố ngôn ngữ (/vi/video/...) về /video/... */
const normalizeUrl = (url) =>
  String(url || "").trim().replace(/^(https?:\/\/(?:www\.|m\.)?bilibili\.com)\/[a-z]{2}(?:-[a-z]{2})?\/(video\/)/i, "$1/$2");

/**
 * repo: sourceRepo (repo.mjs); deps.dub / deps.project: service của module dub / project (ctx.get) hoặc bản giả trong test;
 * deps.tasks: { spawnTask, running } của lib/tasks (bộ chạy tác vụ nền dùng chung).
 */
export function createSourceService(repo, { dub, project, tasks }) {
  /** Chạy 1 script node làm tác vụ nền: trả {ok, task_id} hoặc {ok:false, error} (đang bận). */
  const run = (type, args, target = "", projectId = "") => tasks.spawnTask(type, NODE, args, target, projectId);

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
    async list() {
      const jobs = dub.jobsBySource();
      const owners = repo.owners();
      const sources = [];
      const liveKeys = new Set();
      for (const [dir, source] of [[BILIBILI_DIR, "bilibili"], [DOWNLOADS_DIR, "douyin"]]) {
        for (const { name, full, st } of repo.listMp4(dir)) {
          const info = await probeMedia(full, st);
          liveKeys.add(mediaKey(full, st));
          const rel = relOf(full);
          sources.push({
            source,
            rel_path: rel,
            name,
            size_mb: Number((st.size / 1048576).toFixed(1)),
            mtime: Math.round(st.mtimeMs),
            ...info,
            project_id: owners[rel] || "",
            job: jobs.get(full) || null,
          });
        }
      }
      flushMediaCache(liveKeys);
      sources.sort((a, b) => b.mtime - a.mtime);
      return { total: sources.length, sources };
    },
    /** Đường dẫn tuyệt đối của 1 video nguồn (rel "downloads/...") nếu là file có thật, không thì "". */
    fileOf(rel) {
      const full = resolveDownload(rel);
      return full && repo.isFile(full) ? full : "";
    },
    assign(rel, projectId) {
      const full = resolveDownload(rel);
      const pid = String(projectId || "");
      if (!full || full.startsWith(DUBBED_DIR + path.sep) || !repo.isFile(full)) throw httpError(400, "Video không hợp lệ.");
      if (pid && !project.exists(pid)) throw httpError(404, "Không tìm thấy dự án.");
      repo.setOwner(relOf(full), pid);
      return { ok: true };
    },
    /** Xóa 1 video nguồn (+ job lồng tiếng đang dở của nó; delete_dubbed: cả bản lồng tiếng job_id). */
    remove(body) {
      const resolved = resolveDownload(body.rel_path);
      if (!resolved || resolved.startsWith(DUBBED_DIR + path.sep)) throw httpError(400, "Đường dẫn file không hợp lệ.");
      // Thư mục (vd downloads/bilibili) không phải video: chặn ở đây, không để rmSync ném EISDIR → 500.
      // File không còn trên đĩa vẫn cho xóa để dọn mục gán dự án/bilibili.json còn sót.
      if (repo.exists(resolved) && !repo.isFile(resolved)) throw httpError(400, "Đường dẫn không phải file video.");
      const running = tasks.running();
      if (running?.target && resolveDownload(running.target) === resolved) {
        throw httpError(409, "Video này đang được xử lý. Hãy dừng tiến trình trước khi xóa.");
      }
      if (body.delete_dubbed && dub.busyError()) throw httpError(409, dub.busyError());
      // Job lồng tiếng đang dở của file này cũng vô dụng khi file nguồn mất.
      const pending = dub.jobsBySource().get(resolved);
      if (pending && pending.status !== "done") dub.removeWorkDir(safeJobId(pending.job_id));

      repo.removeVideo(resolved);
      repo.removeFromBiliIndex(path.basename(resolved));
      repo.setOwner(relOf(resolved), "");
      if (body.delete_dubbed) dub.removeJob(safeJobId(body.job_id));
      return { ok: true };
    },
  };
}
