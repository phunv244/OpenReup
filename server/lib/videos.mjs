/**
 * Chỉ mục video: đọc data/videos/<video_key>/video.json (bố cục mới, docs/video-folder-layout.md mục 2),
 * vẫn đọc được bố cục cũ (downloads/..., data/dub_projects, data/dub_work).
 *
 * rel_path "downloads/..." luôn là khóa logic mà API/giao diện dùng. Chỉ mục chỉ đổi nó thành đường dẫn thật
 * ở bố cục mới; rel_path nào không có trong chỉ mục thì đi đường cũ. Không bao giờ tự tính lại video_key
 * (hậu tố -2 phụ thuộc thứ tự quét, mục 8.3 ý 5): mọi tra cứu đi qua video.json. Không đổi hoa/thường.
 *
 * video.json:
 *   { "key": "bilibili-BV1nHW3z3EhH-p1",
 *     "files": { "downloads/bilibili/BV1nHW3z3EhH_p1__.mp4": "source/BV1nHW3z3EhH_p1__.mp4" },
 *     "jobs": ["dub_BV1nHW3z3EhH_p1__0p5x"], ...các trường mô tả khác (platform, title...) }
 * Job: jobs/<job_id>/{project.json, work/, out/<job_id>.mp4|.srt}; bản xuất có rel_path "downloads/dubbed/<job_id>.mp4|.srt".
 * Job mồ côi (mất nguồn): _orphan/jobs/<job_id>/, không có video.json. Thư mục khác bắt đầu bằng "_" bị bỏ qua.
 *
 * Chỉ mục giữ trong bộ nhớ, dựng lại khi mtime của data/videos đổi (thêm/xóa video). Ai sửa video.json
 * của video đã có thì gọi reloadVideoIndex().
 */
import fs from "node:fs";
import path from "node:path";
import { DOWNLOADS_DIR, DUBBED_DIR, MEDIA_ROOT, VIDEOS_DIR } from "../config.mjs";

const ORPHAN = "_orphan";
const OUT_EXTS = [".mp4", ".srt"];
const JOB_ID_RE = /^[0-9A-Za-z_-]+$/;

let cache = null; // { mtime, byRel, byAbs, jobs }

const inside = (dir, p) => p.startsWith(dir + path.sep);
const toRel = (abs) => path.relative(MEDIA_ROOT, abs).split(path.sep).join("/");

function emptyIndex(mtime) {
  return { mtime, byRel: new Map(), byAbs: new Map(), jobs: new Map() };
}

function addJob(idx, videoDir, key, jobId) {
  if (idx.jobs.has(jobId)) {
    console.warn(`[videos] job "${jobId}" có ở cả ${idx.jobs.get(jobId).key} và ${key}: giữ bản đầu`);
    return;
  }
  const base = path.join(videoDir, "jobs", jobId);
  const job = { key, job_id: jobId, project: path.join(base, "project.json"), work: path.join(base, "work"), out: path.join(base, "out") };
  idx.jobs.set(jobId, job);
  for (const ext of OUT_EXTS) addFile(idx, `downloads/dubbed/${jobId}${ext}`, path.join(job.out, jobId + ext), "output", key, jobId);
}

function addFile(idx, rel, abs, kind, key, jobId = "") {
  if (idx.byRel.has(rel)) {
    console.warn(`[videos] rel_path "${rel}" có ở cả ${idx.byRel.get(rel).key} và ${key}: giữ bản đầu`);
    return;
  }
  const entry = { rel, abs, kind, key, job_id: jobId };
  idx.byRel.set(rel, entry);
  idx.byAbs.set(abs, entry);
}

/** Đọc 1 video.json. File hỏng/sai dạng: báo và bỏ qua video đó (dữ liệu trên đĩa, không chặn cả server). */
function addVideo(idx, name) {
  const videoDir = path.join(VIDEOS_DIR, name);
  let v;
  try {
    v = JSON.parse(fs.readFileSync(path.join(videoDir, "video.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`[videos] bỏ qua ${name}/video.json: ${e.message}`);
    return;
  }
  if (v?.key !== name) {
    console.warn(`[videos] bỏ qua ${name}/video.json: key "${v?.key}" khác tên thư mục`);
    return;
  }
  for (const [rel, file] of Object.entries(v.files || {})) {
    const abs = path.resolve(videoDir, String(file));
    // rel phải là khóa downloads/... chuẩn hóa sẵn; file phải nằm trong source/ của chính video này.
    if (path.posix.normalize(rel) !== rel || !rel.startsWith("downloads/") || !inside(path.join(videoDir, "source"), abs)) {
      console.warn(`[videos] bỏ qua ${name}: "${rel}" → "${file}" không hợp lệ`);
      continue;
    }
    addFile(idx, rel, abs, "source", name);
  }
  for (const jobId of v.jobs || []) {
    if (JOB_ID_RE.test(jobId)) addJob(idx, videoDir, name, jobId);
    else console.warn(`[videos] bỏ qua ${name}: job_id "${jobId}" không hợp lệ`);
  }
}

function addOrphans(idx) {
  const dir = path.join(VIDEOS_DIR, ORPHAN);
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, "jobs")).sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const jobId of names) if (JOB_ID_RE.test(jobId)) addJob(idx, dir, ORPHAN, jobId);
}

function index() {
  let mtime;
  try {
    mtime = fs.statSync(VIDEOS_DIR).mtimeMs;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    mtime = -1; // chưa có data/videos/: chỉ có bố cục cũ
  }
  if (cache?.mtime === mtime) return cache;
  const idx = emptyIndex(mtime);
  if (mtime !== -1) {
    // Thứ tự quét cố định (sắp tên) để khi trùng thì luôn giữ cùng một bản.
    for (const name of fs.readdirSync(VIDEOS_DIR).sort()) if (!name.startsWith("_")) addVideo(idx, name);
    addOrphans(idx);
  }
  cache = idx;
  return idx;
}

/** Bỏ chỉ mục trong bộ nhớ, lần tra sau đọc lại video.json. */
export function reloadVideoIndex() {
  cache = null;
}

/**
 * Tra một rel_path "downloads/...". Trả { abs, kind: "source"|"output", key, job_id } hoặc null nếu rel
 * nằm ngoài downloads/ (chống ../). key = "" khi file đang ở bố cục cũ.
 */
export function lookupDownload(rel) {
  const resolved = path.resolve(MEDIA_ROOT, String(rel || ""));
  if (!inside(DOWNLOADS_DIR, resolved)) return null;
  const hit = index().byRel.get(toRel(resolved));
  if (hit) return { abs: hit.abs, kind: hit.kind, key: hit.key, job_id: hit.job_id };
  return { abs: resolved, kind: inside(DUBBED_DIR, resolved) ? "output" : "source", key: "", job_id: "" };
}

/** Ngược lại: đường dẫn thật → rel_path logic. File ở bố cục mới mà không có trong chỉ mục thì trả rel theo MEDIA_ROOT như cũ. */
export function relOfPath(full) {
  const abs = path.resolve(String(full));
  return index().byAbs.get(abs)?.rel ?? toRel(abs);
}

/**
 * Đường dẫn của một job ở bố cục mới: { key, project, work, out }. Job chưa chuyển trả null: chỗ cũ
 * (dub_projects/, dub_work/ hoặc work_dir riêng trong dubbed.json) vẫn do lib/store.mjs tự tính.
 */
export function jobPaths(jobId) {
  const hit = index().jobs.get(jobId);
  return hit ? { key: hit.key, project: hit.project, work: hit.work, out: hit.out } : null;
}
