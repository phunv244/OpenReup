/** Dựng app trên thư mục tạm (REUP_DATA_DIR + REUP_MEDIA_ROOT) — không bao giờ chạm data/ hay downloads/ thật. Gọi trước mọi import của server. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function setupApp(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reup-test-"));
  // Cả data/ lẫn downloads/ (video nguồn, bản xuất downloads/dubbed) đều nằm trong thư mục tạm.
  Object.assign(process.env, { REUP_DATA_DIR: dir, REUP_MEDIA_ROOT: dir }, env);
  const { buildApp } = await import("../app.mjs");
  const { db } = await import("../lib/db.mjs");
  const app = await buildApp();
  const cleanup = async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, dir, cleanup };
}

/** Tạo 1 bản lồng tiếng giả: file project JSON + các câu [start, end] liên tiếp, id 1..n. */
export function seedJob(db, dir, jobId, spans) {
  const projDir = path.join(dir, "dub_projects");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${jobId}.json`), JSON.stringify({ job_id: jobId, voice: "test", speakers: {} }));
  db.prepare("DELETE FROM segments WHERE job_id = ?").run(jobId);
  const ins = db.prepare("INSERT INTO segments (job_id, id, start_s, end_s, zh, vi, speaker) VALUES (?, ?, ?, ?, ?, ?, '')");
  spans.forEach(([s, e], i) => ins.run(jobId, i + 1, s, e, `zh${i + 1}`, `vi${i + 1}`));
}

export const segs = (db, jobId) =>
  db.prepare('SELECT id, start_s AS start, end_s AS "end", zh, vi FROM segments WHERE job_id = ? ORDER BY start_s, id').all(jobId).map((r) => ({ ...r }));
