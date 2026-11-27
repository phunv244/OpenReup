/**
 * Nhật ký các lần gọi hàm /api/functions (SQLite: bảng function_calls), dùng chung cho:
 *   - lớp chạy hàm server/routes/functions.mjs (ghi: tạo bản ghi, đánh dấu xong/lỗi),
 *   - module tasks (đọc: get_call, list_calls; chờ 1 lần gọi xong).
 */
import { db } from "./db.mjs";
import { nowIso } from "./util.mjs";

export const MAX_WAIT_SEC = 3600;

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return s;
  }
};
const rowOut = (r) =>
  r && {
    call_id: r.id, name: r.name, arguments: parse(r.args), status: r.status, ok: r.status !== "error" && r.status !== "stopped",
    result: parse(r.result), error: r.error || null, log_file: r.log_file || null, created_at: r.created_at, ended_at: r.ended_at,
  };

export const getCall = (id) => rowOut(db.prepare("SELECT * FROM function_calls WHERE id = ?").get(id));

export function listCalls({ limit, status, name } = {}) {
  const where = [];
  const params = [];
  if (status) where.push("status = ?"), params.push(String(status));
  if (name) where.push("name = ?"), params.push(String(name));
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  return db
    .prepare(`SELECT * FROM function_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params, n)
    .map(rowOut);
}

/** Tạo bản ghi 1 lần gọi (status: running), trả call_id. */
export const startCall = (name, args) =>
  Number(db.prepare("INSERT INTO function_calls (name, args, status, created_at) VALUES (?, ?, 'running', ?)").run(name, JSON.stringify(args ?? {}), nowIso()).lastInsertRowid);

/** Tác vụ nền đã nhận: lần gọi chuyển sang queued/running, kèm task_id và ghi chú tạm. */
export const markTask = (id, status, taskId, note) =>
  db.prepare("UPDATE function_calls SET status = ?, task_id = ?, result = ? WHERE id = ?").run(status, taskId, JSON.stringify(note), id);

export const markRunning = (id) => db.prepare("UPDATE function_calls SET status = 'running' WHERE id = ? AND status = 'queued'").run(id);

/** Server khởi động lại: lần gọi còn queued/running không bao giờ có kết quả nữa. */
export const stopOrphans = () =>
  db.prepare("UPDATE function_calls SET status = 'stopped', error = 'Server khởi động lại khi tác vụ chưa xong.', ended_at = ? WHERE status IN ('queued', 'running')").run(nowIso());

const waiters = new Map(); // call_id -> [hàm đánh thức]

export function finishCall(id, status, { result = null, error = null, logFile = null } = {}) {
  db.prepare("UPDATE function_calls SET status = ?, result = ?, error = ?, log_file = coalesce(?, log_file), ended_at = ? WHERE id = ?").run(
    status, result === null ? null : JSON.stringify(result), error, logFile, nowIso(), id
  );
  for (const wake of waiters.get(id) || []) wake();
  waiters.delete(id);
}

/** Chờ tối đa sec giây cho tới khi lần gọi id hết queued/running (trả ngay nếu sec=0 hoặc đã xong). */
export function waitCall(id, sec) {
  const s = Math.min(MAX_WAIT_SEC, Number(sec) || 0);
  const c = getCall(id);
  if (!s || !c || !["queued", "running"].includes(c.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, s * 1000);
    waiters.set(id, [...(waiters.get(id) || []), () => (clearTimeout(t), resolve())]);
  });
}
