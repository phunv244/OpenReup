/** Dữ liệu Douyin / Bilibili / bản lồng tiếng / video theo dự án (file JSON trong data/). */
import fs from "node:fs";
import path from "node:path";
import {
  BILIBILI_JSON, DATA_JSON, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR, DUBBED_DIR, DUBBED_JSON, DUB_PROJECTS_DIR,
  DUB_WORK_DIR, ROOT, VIDEO_PROJECTS_JSON,
} from "../config.mjs";
import { db } from "./db.mjs";
import { task } from "./tasks.mjs";
import { readJson, relOf, writeJson } from "./util.mjs";

/* ---------- Video nào thuộc dự án nào ---------- */
export function readVideoProjects() {
  return readJson(VIDEO_PROJECTS_JSON, {});
}

export function setVideoProject(rel, projectId) {
  const map = readVideoProjects();
  if (projectId) map[rel] = projectId;
  else delete map[rel];
  writeJson(VIDEO_PROJECTS_JSON, map);
}

/** Gỡ mọi video nguồn khỏi dự án (dự án bị xóa). File media không bị xóa. Bản lồng tiếng: module dub (unassignProject). */
export function unassignVideoProjects(projectId) {
  const map = readVideoProjects();
  for (const rel of Object.keys(map)) if (map[rel] === projectId) delete map[rel];
  writeJson(VIDEO_PROJECTS_JSON, map);
}

/**
 * job_id → thư mục làm việc tuyệt đối: data/dub_work/<job>, rồi ghi đè bằng work_dir Python lưu trong dubbed.json
 * (tương đối với ROOT hoặc tuyệt đối) — thư mục job có thể đã được đổi tên / chuyển chỗ.
 */
export function dubWorkDirs() {
  const out = new Map();
  if (fs.existsSync(DUB_WORK_DIR)) for (const dir of fs.readdirSync(DUB_WORK_DIR)) out.set(dir, path.join(DUB_WORK_DIR, dir));
  for (const v of readDubbed()) if (v.job_id && v.work_dir) out.set(v.job_id, path.resolve(ROOT, String(v.work_dir)));
  return out;
}

/**
 * Thư mục làm việc của 1 job để xóa. Chỉ nhận thư mục thật (đã giải symlink) nằm bên trong data/dub_work/;
 * work_dir trỏ ra ngoài (data/projects, chính data/dub_work, symlink ra ngoài…) hoặc không tồn tại → null, không xóa gì.
 */
export function dubWorkDir(jobId) {
  const dir = dubWorkDirs().get(jobId) || path.join(DUB_WORK_DIR, jobId);
  if (!fs.existsSync(dir) || !fs.existsSync(DUB_WORK_DIR)) return null;
  const real = fs.realpathSync(dir);
  return real.startsWith(fs.realpathSync(DUB_WORK_DIR) + path.sep) ? real : null;
}

/** Xóa thư mục làm việc (cache/checkpoint) của 1 job, chỉ khi nó nằm trong data/dub_work/. */
export function removeDubWorkDir(jobId) {
  const dir = dubWorkDir(jobId);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- Douyin ---------- */
export function readVideosData() {
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

/* ---------- Bản lồng tiếng ---------- */
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

export function removeFromBiliIndex(fname) {
  if (!fs.existsSync(BILIBILI_JSON)) return;
  const d = readJson(BILIBILI_JSON, { videos: [] });
  d.videos = (d.videos || []).filter((v) => v.local_file !== fname);
  d.total = d.videos.length;
  d.updated_at = new Date().toISOString().slice(0, 19);
  writeJson(BILIBILI_JSON, d);
}

export function loadDubProject(jobId) {
  const file = path.join(DUB_PROJECTS_DIR, `${jobId}.json`);
  if (!jobId || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveDubProject(jobId, proj) {
  writeJson(path.join(DUB_PROJECTS_DIR, `${jobId}.json`), proj, 0);
}

/** Xóa sạch 1 bản lồng tiếng: video, phụ đề, lời dịch và thư mục cache/checkpoint. */
export function removeDubJob(jobId) {
  if (!jobId) return;
  for (const p of [
    path.join(DUBBED_DIR, `${jobId}.mp4`),
    path.join(DUBBED_DIR, `${jobId}.srt`),
    path.join(DUB_PROJECTS_DIR, `${jobId}.json`),
  ]) {
    fs.rmSync(p, { force: true });
  }
  removeDubWorkDir(jobId);
  db.prepare("DELETE FROM segments WHERE job_id = ?").run(jobId);
  db.prepare("DELETE FROM timeline_dirty WHERE job_id = ?").run(jobId);
  updateDubbed((vids) => vids.filter((v) => v.job_id !== jobId));
}

/** Trạng thái các job lồng tiếng theo file nguồn (để hiện "đang dở 43% — Tiếp tục"). */
export function readDubJobs() {
  const byInput = new Map();
  for (const [dir, workDir] of dubWorkDirs()) {
    const meta = readJson(path.join(workDir, "meta.json"), null);
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
