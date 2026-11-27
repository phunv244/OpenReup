/** Dữ liệu Douyin / Bilibili / bản lồng tiếng / video theo dự án (file JSON trong data/). */
import fs from "node:fs";
import path from "node:path";
import {
  BILIBILI_JSON, DATA_JSON, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR, DUBBED_DIR, DUBBED_JSON, DUB_PROJECTS_DIR,
  DUB_WORK_DIR, VIDEO_PROJECTS_JSON,
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

/** Gỡ mọi video nguồn và bản lồng tiếng khỏi dự án (dự án bị xóa). File media không bị xóa. */
export function unassignProject(projectId) {
  const map = readVideoProjects();
  for (const rel of Object.keys(map)) if (map[rel] === projectId) delete map[rel];
  writeJson(VIDEO_PROJECTS_JSON, map);
  updateDubbed((vids) => vids.forEach((v) => v.project_id === projectId && (v.project_id = "")));
}

/** job_id → video nguồn (đường dẫn tương đối) của bản lồng tiếng, đọc từ meta.json của job. */
export function readDubSources() {
  const out = new Map();
  if (!fs.existsSync(DUB_WORK_DIR)) return out;
  for (const dir of fs.readdirSync(DUB_WORK_DIR)) {
    const meta = readJson(path.join(DUB_WORK_DIR, dir, "meta.json"), null);
    if (meta?.input_path) out.set(meta.job_id || dir, relOf(meta.input_path));
  }
  return out;
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
  fs.rmSync(path.join(DUB_WORK_DIR, jobId), { recursive: true, force: true });
  db.prepare("DELETE FROM segments WHERE job_id = ?").run(jobId);
  db.prepare("DELETE FROM timeline_dirty WHERE job_id = ?").run(jobId);
  updateDubbed((vids) => vids.filter((v) => v.job_id !== jobId));
}

/** Trạng thái các job lồng tiếng theo file nguồn (để hiện "đang dở 43% — Tiếp tục"). */
export function readDubJobs() {
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
