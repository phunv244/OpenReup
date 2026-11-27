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
  // Thứ tự timeline (start_s, id): trang câu thoại, thanh timeline, câu liền trước/sau khi kéo mốc giờ — không phải quét + sắp cả job.
  d.exec("CREATE INDEX IF NOT EXISTS idx_segments_timeline ON segments (job_id, start_s, id)");
  // Nhật ký các lần model gọi hàm (routes/functions.mjs): tham số, trạng thái, kết quả / lỗi, file log.
  d.exec(`CREATE TABLE IF NOT EXISTS function_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL,
    task_id INTEGER, result TEXT, error TEXT, log_file TEXT, created_at TEXT NOT NULL, ended_at TEXT)`);
  // Timeline bị split/merge/delete/kéo mốc giờ sau lần xuất gần nhất: lần xuất lại kế tiếp phải làm cả hình lẫn tiếng.
  // rev tăng mỗi lần sửa; xuất xong chỉ xóa nếu chưa có sửa mới trong lúc chạy. Không để trong JSON project vì dub_video.py ghi đè file đó.
  d.exec("CREATE TABLE IF NOT EXISTS timeline_dirty (job_id TEXT PRIMARY KEY, rev INTEGER NOT NULL) WITHOUT ROWID");
  // Tác vụ module Threads (VideoThreads + ReupThreads): lưu trong cùng SQLite WAL data/openreup.db.
  d.exec(`CREATE TABLE IF NOT EXISTS threads_jobs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
    local_video_path TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
    params TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '', task_id INTEGER, output_rel_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_threads_jobs_created ON threads_jobs (created_at DESC)");
  // lower() của SQLite chỉ hiểu ASCII: tìm "đây" phải khớp cả "Đây".
  d.function("lc", { deterministic: true }, (v) => String(v ?? "").toLowerCase());
  return d;
}

export const db = openDb();

export function inTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
