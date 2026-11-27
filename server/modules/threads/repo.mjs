/** Lưu trữ job Threads (VideoThreads & ReupThreads) trên SQLite WAL chung (data/openreup.db). */
import { db } from "../../lib/db.mjs";

const parseJson = (raw, fallback = {}) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    url: row.url,
    local_video_path: row.local_video_path,
    status: row.status,
    params: parseJson(row.params, {}),
    result: parseJson(row.result, {}),
    error: row.error || "",
    task_id: row.task_id ?? null,
    output_rel_path: row.output_rel_path || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const threadsRepo = {
  list(limit = 50) {
    const cap = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = db
      .prepare("SELECT * FROM threads_jobs ORDER BY created_at DESC LIMIT ?")
      .all(cap);
    return rows.map(hydrate);
  },

  get(id) {
    const row = db.prepare("SELECT * FROM threads_jobs WHERE id = ?").get(String(id));
    return hydrate(row);
  },

  create({ id, mode, url = "", local_video_path = "", status = "queued", params = {}, task_id = null }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads_jobs (id, mode, url, local_video_path, status, params, result, error, task_id, output_rel_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', '', ?, '', ?, ?)`,
    ).run(id, mode, url, local_video_path, status, JSON.stringify(params), task_id, now, now);
    return this.get(id);
  },

  update(id, patch = {}) {
    const cur = this.get(id);
    if (!cur) return null;
    const now = new Date().toISOString();
    const next = {
      status: patch.status ?? cur.status,
      result: patch.result !== undefined ? JSON.stringify(patch.result) : JSON.stringify(cur.result),
      error: patch.error !== undefined ? String(patch.error) : cur.error,
      task_id: patch.task_id !== undefined ? patch.task_id : cur.task_id,
      output_rel_path: patch.output_rel_path !== undefined ? String(patch.output_rel_path) : cur.output_rel_path,
    };
    db.prepare(
      `UPDATE threads_jobs
       SET status = ?, result = ?, error = ?, task_id = ?, output_rel_path = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.status, next.result, next.error, next.task_id, next.output_rel_path, now, id);
    return this.get(id);
  },

  remove(id) {
    const res = db.prepare("DELETE FROM threads_jobs WHERE id = ?").run(String(id));
    return res.changes > 0;
  },
};
