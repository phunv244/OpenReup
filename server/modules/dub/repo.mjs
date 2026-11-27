/**
 * File của module dub: data/dubbed.json, file project của job (data/dub_projects/<job>.json hoặc jobs/<job>/project.json),
 * thư mục làm việc <work_dir>/meta.json, bản xuất .mp4/.srt. Câu thoại (SQLite): segments-repo.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { DUBBED_DIR, DUBBED_JSON, DUB_PROJECTS_DIR, DUB_WORK_DIR, ROOT, VIDEOS_DIR } from "../../config.mjs";
import { dubBusyError, queue, task } from "../../lib/tasks.mjs";
import { readJson, relOf, writeJson } from "../../lib/util.mjs";
import { jobPaths, videoJobs } from "../../lib/videos.mjs";
import { segmentsRepo } from "./segments-repo.mjs";

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function readDubbed() {
  return readJson(DUBBED_JSON, {}).videos || [];
}

export function updateDubbed(mutate) {
  if (!fs.existsSync(DUBBED_JSON)) return;
  const d = readJson(DUBBED_JSON, { videos: [] });
  d.videos = mutate(d.videos || []) || d.videos;
  d.total = d.videos.length;
  writeJson(DUBBED_JSON, d);
}

/**
 * job_id → thư mục làm việc tuyệt đối: data/dub_work/<job>, rồi ghi đè bằng work_dir Python lưu trong dubbed.json
 * (tương đối với ROOT hoặc tuyệt đối) — thư mục job có thể đã được đổi tên / chuyển chỗ; cuối cùng job đã ở
 * bố cục mới thì luôn là data/videos/<key>/jobs/<job>/work (chỉ mục video.json).
 */
export function dubWorkDirs() {
  const out = new Map();
  if (fs.existsSync(DUB_WORK_DIR)) for (const dir of fs.readdirSync(DUB_WORK_DIR)) out.set(dir, path.join(DUB_WORK_DIR, dir));
  for (const v of readDubbed()) if (v.job_id && v.work_dir) out.set(v.job_id, path.resolve(ROOT, String(v.work_dir)));
  for (const j of videoJobs()) out.set(j.job_id, j.work);
  return out;
}

/** File project của 1 job: jobs/<job>/project.json ở bố cục mới, không thì data/dub_projects/<job>.json. */
const dubProjectFile = (jobId) => jobPaths(jobId)?.project || path.join(DUB_PROJECTS_DIR, `${jobId}.json`);

/**
 * Thư mục làm việc của 1 job để xóa. Chỉ nhận thư mục thật (đã giải symlink) và đúng của job này:
 * - bố cục cũ: nằm bên trong data/dub_work/ và mang đúng tên job;
 * - bố cục mới: đúng data/videos/<key>/jobs/<job>/work của job trong chỉ mục.
 * work_dir trỏ ra ngoài (data/projects, chính data/dub_work, symlink ra ngoài, thư mục job khác…) hoặc không tồn tại → null, không xóa gì.
 */
export function dubWorkDir(jobId) {
  const dir = dubWorkDirs().get(jobId) || path.join(DUB_WORK_DIR, jobId);
  const real = realOrNull(dir);
  if (!real) return null; // thư mục không có / vừa bị xóa giữa chừng
  const jp = jobPaths(jobId);
  if (jp) {
    const videos = realOrNull(VIDEOS_DIR);
    const ok = videos && real.startsWith(videos + path.sep) && real === path.join(realOrNull(path.dirname(jp.work)) || "", "work");
    return ok && path.basename(path.dirname(real)) === jobId ? real : null;
  }
  const root = realOrNull(DUB_WORK_DIR);
  // Phải đúng thư mục của chính job này: work_dir của job A không được trỏ sang thư mục job B.
  return root && real.startsWith(root + path.sep) && path.basename(real) === jobId ? real : null;
}

/** Xóa thư mục làm việc (cache/checkpoint) của 1 job, chỉ khi dubWorkDir nhận nó. */
export function removeDubWorkDir(jobId) {
  const dir = dubWorkDir(jobId);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

export function loadDubProject(jobId) {
  if (!jobId) return null;
  const file = dubProjectFile(jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveDubProject(jobId, proj) {
  writeJson(dubProjectFile(jobId), proj, 0);
}

/** Xóa sạch 1 bản lồng tiếng: video, phụ đề, file project, câu thoại, cờ timeline và thư mục cache/checkpoint. */
export function removeDubJob(jobId) {
  if (!jobId) return;
  const outDir = jobPaths(jobId)?.out || DUBBED_DIR;
  for (const p of [path.join(outDir, `${jobId}.mp4`), path.join(outDir, `${jobId}.srt`), dubProjectFile(jobId)]) {
    fs.rmSync(p, { force: true });
  }
  removeDubWorkDir(jobId);
  segmentsRepo.removeJob(jobId);
  updateDubbed((vids) => vids.filter((v) => v.job_id !== jobId));
}

/**
 * Trạng thái các job lồng tiếng theo rel_path logic của file nguồn (để hiện "đang dở 43% — Tiếp tục").
 * Khóa là relOf(meta.input_path), không phải đường dẫn tuyệt đối: meta ghi đường dẫn cũ hay mới đều ghép đúng video.
 */
export function readDubJobs() {
  const byRel = new Map();
  for (const [dir, workDir] of dubWorkDirs()) {
    const meta = readJson(path.join(workDir, "meta.json"), null);
    if (!meta?.input_path || !meta.status) continue;
    let status = meta.status;
    // Ghi "running" nhưng không có tiến trình nào => lần trước bị tắt đột ngột, coi như đang dở.
    if (status === "running" && !(task.proc && task.type === "dub_video")) status = "stopped";
    byRel.set(relOf(meta.input_path), {
      job_id: meta.job_id || dir,
      status,
      pct: Number(meta.pct || 0),
      label: meta.label || "",
      error: meta.error || "",
      params: meta.params || {},
      updated_at: meta.updated_at || "",
    });
  }
  return byRel;
}

export const dubRepo = {
  readDubbed,
  updateDubbed,
  loadDubProject,
  saveDubProject,
  removeDubJob,
  readDubJobs,
  removeDubWorkDir,
  busyError: dubBusyError,

  /** job_id → video nguồn (rel) của bản lồng tiếng, đọc meta.json theo thư mục làm việc. */
  readDubSources() {
    const out = new Map();
    for (const [jobId, dir] of dubWorkDirs()) {
      const meta = readJson(path.join(dir, "meta.json"), null);
      if (meta?.input_path) out.set(meta.job_id || jobId, relOf(meta.input_path));
    }
    return out;
  },

  /** Tác vụ lồng tiếng đang chạy + đang chờ: [{ type, target, args }]. */
  dubTasks: () => [...(task.proc ? [task] : []), ...queue].filter((t) => t.type.startsWith("dub_")),
};
