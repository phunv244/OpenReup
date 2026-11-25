/**
 * Câu thoại nằm trong SQLite (data/openreup.db): sửa 1 câu là 1 lệnh UPDATE, tìm kiếm không phải nạp cả file.
 * File data/dub_projects/<job>.json chỉ còn thông tin chung (giọng, logo, nhân vật...). Lược đồ khớp dub_video.py (open_db).
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_PATH } from "../config.mjs";

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;"); // dub_video.py ghi cùng file này
  d.exec(`CREATE TABLE IF NOT EXISTS segments (
    job_id TEXT NOT NULL, id INTEGER NOT NULL, start_s REAL NOT NULL, end_s REAL NOT NULL,
    zh TEXT NOT NULL DEFAULT '', vi TEXT NOT NULL DEFAULT '', speaker TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (job_id, id)) WITHOUT ROWID`);
  // lower() của SQLite chỉ hiểu ASCII: tìm "đây" phải khớp cả "Đây".
  d.function("lc", { deterministic: true }, (v) => String(v ?? "").toLowerCase());
  return d;
}

export const db = openDb();

export function inTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
