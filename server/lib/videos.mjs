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
 * Chỉ mục giữ trong bộ nhớ. Quá INDEX_TTL_MS kể từ lần kiểm trước thì so "chữ ký" (tên thư mục video +
 * ino/mtime/size của từng video.json, danh sách _orphan/jobs): đổi thì dựng lại. Trong khoảng đó mọi lần tra
 * dùng lại chỉ mục, không đọc đĩa (một request /api/sources tra hàng trăm file chỉ kiểm chữ ký một lần).
 * Ghi video.json thì dùng writeVideoJson (file tạm rồi rename: không ai đọc được file ghi dở, và làm mới chỉ mục
 * ngay). Chỗ nào ghi data/videos/ bằng cách khác (sửa tay, tiến trình khác) thì thấy được sau tối đa INDEX_TTL_MS.
 *
 * Symlink: đường dẫn trả ra phải nằm thật (đã giải symlink) trong source/ hoặc out/ của chính video/job đó,
 * hay trong downloads/ ở bố cục cũ; trỏ ra ngoài thì coi như không có (null).
 */
import fs from "node:fs";
import path from "node:path";
import { DOWNLOADS_DIR, DUB_WORK_DIR, DUBBED_DIR, MEDIA_ROOT, ROOT, VIDEOS_DIR } from "../config.mjs";

const ORPHAN = "_orphan";
const OUT_EXTS = [".mp4", ".srt"];
const JOB_ID_RE = /^[0-9A-Za-z_-]+$/;

/** Thời gian dùng lại chỉ mục mà không kiểm chữ ký trên đĩa. */
export const INDEX_TTL_MS = 1000;

let cache = null; // { sig, at, realVideos, byRel, byAbs, jobs }

const inside = (dir, p) => p.startsWith(dir + path.sep);

/** realpath của p; phần cuối chưa có trên đĩa thì giải symlink của thư mục cha gần nhất đã có rồi ghép phần còn lại. */
function realish(p) {
  const rest = [];
  for (let cur = p; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      if (cur === path.dirname(cur)) return p;
      rest.push(path.basename(cur));
    }
  }
}

/** p (sau khi giải symlink) có nằm trong root (cũng đã giải symlink) không. */
const realInside = (root, p) => inside(realish(root), realish(p));
const toRel = (abs) => path.relative(MEDIA_ROOT, abs).split(path.sep).join("/");

function emptyIndex(sig) {
  return { sig, at: 0, realVideos: realish(VIDEOS_DIR), byRel: new Map(), byAbs: new Map(), jobs: new Map() };
}

function addJob(idx, videoDir, key, jobId) {
  if (idx.jobs.has(jobId)) {
    console.warn(`[videos] job "${jobId}" có ở cả ${idx.jobs.get(jobId).key} và ${key}: giữ bản đầu`);
    return;
  }
  const base = path.join(videoDir, "jobs", jobId);
  const job = { key, job_id: jobId, project: path.join(base, "project.json"), work: path.join(base, "work"), out: path.join(base, "out") };
  idx.jobs.set(jobId, job);
  for (const ext of OUT_EXTS) addFile(idx, `downloads/dubbed/${jobId}${ext}`, path.join(job.out, jobId + ext), "output", key, jobId, job.out);
}

function addFile(idx, rel, abs, kind, key, jobId, root) {
  if (idx.byRel.has(rel)) {
    console.warn(`[videos] rel_path "${rel}" có ở cả ${idx.byRel.get(rel).key} và ${key}: giữ bản đầu`);
    return;
  }
  const entry = { rel, abs, kind, key, job_id: jobId, root };
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
    addFile(idx, rel, abs, "source", name, "", path.join(videoDir, "source"));
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

const readdir = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
};

/** Chữ ký của data/videos: đổi khi thêm/xóa thư mục video, khi video.json được tạo/thay (rename → ino mới), khi thêm/bớt job mồ côi. */
function signature(names) {
  if (!names) return "-";
  const parts = names.map((name) => {
    if (name.startsWith("_")) return name;
    try {
      const st = fs.statSync(path.join(VIDEOS_DIR, name, "video.json"));
      return `${name}:${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${name}:-`;
    }
  });
  return parts.join("|") + "#" + (readdir(path.join(VIDEOS_DIR, ORPHAN, "jobs")) || []).join("|");
}

function index() {
  const now = performance.now();
  if (cache && now - cache.at < INDEX_TTL_MS) return cache;
  const names = readdir(VIDEOS_DIR); // null: chưa có data/videos/, chỉ có bố cục cũ
  const sig = signature(names);
  if (cache?.sig === sig) {
    cache.at = now;
    return cache;
  }
  const idx = emptyIndex(sig);
  idx.at = now;
  if (names) {
    // Thứ tự quét cố định (sắp tên) để khi trùng thì luôn giữ cùng một bản.
    for (const name of names) if (!name.startsWith("_")) addVideo(idx, name);
    addOrphans(idx);
  }
  cache = idx;
  return idx;
}

/** Bỏ chỉ mục trong bộ nhớ, lần tra sau đọc lại video.json. */
export function reloadVideoIndex() {
  cache = null;
}

/** Ghi data/videos/<key>/video.json an toàn: file tạm cùng thư mục rồi rename, sau đó làm mới chỉ mục. Mọi chỗ ghi video.json dùng hàm này. */
export function writeVideoJson(key, data) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key) || data?.key !== key) throw new Error(`video_key không hợp lệ: "${key}"`);
  const file = path.join(VIDEOS_DIR, key, "video.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  reloadVideoIndex();
}

/** Mọi job ở bố cục mới: [{ key, job_id, project, work, out }]. */
export const videoJobs = () => [...index().jobs.values()].map((j) => ({ ...j }));

/**
 * Tra một rel_path "downloads/...". Trả { abs, kind: "source"|"output", key, job_id } hoặc null nếu rel
 * nằm ngoài downloads/ (chống ../). key = "" khi file đang ở bố cục cũ.
 */
export function lookupDownload(rel) {
  if (String(rel || "").includes("\0")) return null;
  const resolved = path.resolve(MEDIA_ROOT, String(rel || ""));
  if (!inside(DOWNLOADS_DIR, resolved)) return null;
  const idx = index();
  const hit = idx.byRel.get(toRel(resolved));
  if (hit) {
    // Mọi thư mục từ data/videos xuống source/ hay out/ phải là thư mục thật (không symlink), và file nằm thật trong đó.
    const root = path.join(idx.realVideos, path.relative(VIDEOS_DIR, hit.root));
    return inside(root, realish(hit.abs)) ? { abs: hit.abs, kind: hit.kind, key: hit.key, job_id: hit.job_id } : null;
  }
  if (!realInside(DOWNLOADS_DIR, resolved)) return null; // symlink trong downloads/ trỏ ra ngoài
  return { abs: resolved, kind: realInside(DUBBED_DIR, resolved) ? "output" : "source", key: "", job_id: "" };
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

/**
 * /api/dub/segments trả input_path / work_dir / out_dir theo dạng cũ khi job ở bố cục mới (mục 8.1 ý 2): chỉ đổi
 * trường đang trỏ đúng chỗ mới của chính job đó (nguồn trong chỉ mục, jobs/<job>/work, jobs/<job>/out), giữ kiểu
 * lưu (tuyệt đối, hoặc tương đối theo thư mục dự án như dub_video.py rel_to_base). Không ghi gì xuống file.
 * Job chưa chuyển, hay giá trị trỏ chỗ khác (job mồ côi không có rel_path nguồn) thì trả nguyên.
 */
export function legacyJobFields(jobId, proj) {
  const jp = jobPaths(jobId);
  if (!jp) return proj;
  const out = { ...proj };
  const remap = (field, from, to) => {
    const v = proj[field];
    if (typeof v !== "string" || !v) return;
    const abs = path.resolve(ROOT, v);
    const target = to(abs, from);
    if (!target) return;
    out[field] = path.isAbsolute(v) ? target : path.relative(ROOT, target);
  };
  remap("input_path", null, (abs) => {
    const hit = index().byAbs.get(abs);
    return hit?.kind === "source" ? path.join(MEDIA_ROOT, hit.rel) : "";
  });
  remap("work_dir", jp.work, (abs, from) => (abs === from ? path.join(DUB_WORK_DIR, jobId) : ""));
  remap("out_dir", jp.out, (abs, from) => (abs === from ? DUBBED_DIR : ""));
  return out;
}
