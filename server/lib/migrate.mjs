/** Chuyển dữ liệu đời cũ, chạy mỗi lần khởi động nhưng chỉ ghi khi còn dữ liệu cũ. */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_VOICE, DOWNLOADS_DIR, DUBBED_JSON, DUB_PROJECTS_DIR, DUB_WORK_DIR, ROOT, STORY_PROJECTS_DIR, VIDEO_PROJECTS_JSON,
} from "../config.mjs";
import { db, inTransaction } from "./db.mjs";
import { readJson, safeJobId, writeJson } from "./util.mjs";

/** File project đời cũ (chứa mảng "segments") sang SQLite, 1 lần. Bản JSON gốc được giữ trong _backup_json. */
function migrateDubProjects() {
  if (!fs.existsSync(DUB_PROJECTS_DIR)) return;
  const count = db.prepare("SELECT count(*) AS n FROM segments WHERE job_id = ?");
  const insert = db.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const name of fs.readdirSync(DUB_PROJECTS_DIR)) {
    const jobId = safeJobId(name.replace(/\.json$/, ""));
    if (!name.endsWith(".json") || !jobId) continue;
    const file = path.join(DUB_PROJECTS_DIR, name);
    try {
      const proj = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(proj.segments)) continue;
      const backup = path.join(DUB_PROJECTS_DIR, "_backup_json", name);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      if (!count.get(jobId).n) {
        inTransaction(() =>
          proj.segments.forEach((seg, i) =>
            insert.run(jobId, seg.id || i + 1, seg.start, seg.end, seg.zh || "", seg.vi || "", seg.speaker || "")
          )
        );
      }
      const { segments, ...info } = proj;
      writeJson(file, info, 0);
      console.log(`[DB] Đã chuyển ${segments.length} câu thoại của ${jobId} sang SQLite.`);
    } catch (err) {
      console.error(`[DB] Không chuyển được ${name}: ${err.message}`);
    }
  }
}

/** Lần đầu: gán video đã lồng tiếng vào dự án của bản lồng tiếng. Video còn lại để "chưa gán" cho người dùng chọn. */
function migrateVideoProjects() {
  if (fs.existsSync(VIDEO_PROJECTS_JSON)) return;
  const map = {};
  for (const d of readJson(DUBBED_JSON, { videos: [] }).videos || []) {
    if (!d.project_id || !d.title) continue;
    for (const rel of [`downloads/bilibili/${d.title}`, `downloads/${d.title}`]) {
      if (fs.existsSync(path.join(ROOT, rel))) map[rel] = d.project_id;
    }
  }
  writeJson(VIDEO_PROJECTS_JSON, map);
}

/** Bản lồng tiếng trỏ tới dự án đã bị xóa (trước khi xóa dự án biết gỡ bản lồng tiếng) thành "chưa gán dự án". */
function dropOrphanDubProjects() {
  const d = readJson(DUBBED_JSON, null);
  const orphans = (d?.videos || []).filter((v) => v.project_id && !fs.existsSync(path.join(STORY_PROJECTS_DIR, `${v.project_id}.json`)));
  if (!orphans.length) return;
  for (const v of orphans) v.project_id = "";
  writeJson(DUBBED_JSON, d);
  console.log(`[DATA] Gỡ ${orphans.length} bản lồng tiếng khỏi dự án đã xóa: ${orphans.map((v) => v.job_id).join(", ")}`);
}

/** Bỏ Edge-TTS: đổi giọng Edge đã lưu (dự án, bản lồng tiếng, job dở) sang giọng VieNeu gần nhất. */
function migrateEdgeVoices() {
  const MAP = { "vi-VN-NamMinhNeural": "vieneu:Thiện Minh", "vi-VN-HoaiMyNeural": "vieneu:Ngọc Huyền" };
  const fix = (v) => (typeof v === "string" && v.startsWith("vi-VN-") ? MAP[v] || DEFAULT_VOICE : v);
  const files = [DUBBED_JSON];
  for (const dir of [STORY_PROJECTS_DIR, DUB_PROJECTS_DIR]) {
    if (fs.existsSync(dir)) files.push(...fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)));
  }
  if (fs.existsSync(DUB_WORK_DIR)) files.push(...fs.readdirSync(DUB_WORK_DIR).map((d) => path.join(DUB_WORK_DIR, d, "meta.json")));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.includes('"vi-VN-')) continue;
    const data = JSON.parse(raw);
    for (const obj of [data, data.params, ...(data.videos || []), ...Object.values(data.speakers || {})]) {
      if (obj && typeof obj === "object" && "voice" in obj) obj.voice = fix(obj.voice);
      if (obj && typeof obj === "object") delete obj.tts_rate; // tham số riêng của Edge
    }
    if (Array.isArray(data.voices)) data.voices = [...new Set(data.voices.map(fix))];
    writeJson(file, data, file.startsWith(DUB_PROJECTS_DIR) ? 0 : 2);
    console.log(`[Giọng đọc] Đã đổi giọng Edge sang VieNeu trong ${path.relative(ROOT, file)}`);
  }
}

export function runMigrations() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  migrateDubProjects();
  migrateVideoProjects();
  migrateEdgeVoices();
  dropOrphanDubProjects();
}
