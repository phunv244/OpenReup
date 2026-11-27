/**
 * SQL của module dub: câu thoại (bảng segments) và cờ "timeline đã đổi" (bảng timeline_dirty).
 * Mọi câu lệnh chuẩn bị 1 lần lúc nạp module. Thứ tự timeline luôn là (start_s, id), có chỉ mục idx_segments_timeline (lib/db.mjs).
 */
import { db, inTransaction } from "../../lib/db.mjs";

const COLS = `id, start_s AS start, end_s AS "end", zh, vi, speaker`;
const q = {
  totals: db.prepare("SELECT count(*) AS total, coalesce(sum(vi = ''), 0) AS empty FROM segments WHERE job_id = ?"),
  count: db.prepare("SELECT count(*) AS n FROM segments WHERE job_id = ?"),
  firstN: db.prepare(`SELECT ${COLS} FROM segments WHERE job_id = ? ORDER BY start_s, id LIMIT ?`),
  row: db.prepare("SELECT * FROM segments WHERE job_id = ? AND id = ?"),
  prevEnd: db.prepare('SELECT end_s AS "end" FROM segments WHERE job_id = ? AND start_s < ? ORDER BY start_s DESC LIMIT 1'),
  nextStart: db.prepare("SELECT start_s AS start FROM segments WHERE job_id = ? AND start_s > ? ORDER BY start_s ASC LIMIT 1"),
  maxId: db.prepare("SELECT max(id) AS m FROM segments WHERE job_id = ?"),
  between: db.prepare("SELECT count(*) AS n FROM segments WHERE job_id = ? AND (start_s, id) > (?, ?) AND (start_s, id) < (?, ?)"),
  setVi: db.prepare("UPDATE segments SET vi = ? WHERE job_id = ? AND id = ?"),
  setSpeaker: db.prepare("UPDATE segments SET speaker = ? WHERE job_id = ? AND id = ?"),
  setSpan: db.prepare("UPDATE segments SET start_s = ?, end_s = ? WHERE job_id = ? AND id = ?"),
  setSpanSpeaker: db.prepare("UPDATE segments SET start_s = ?, end_s = ?, speaker = ? WHERE job_id = ? AND id = ?"),
  setEnd: db.prepare("UPDATE segments SET end_s = ? WHERE job_id = ? AND id = ?"),
  setMerged: db.prepare("UPDATE segments SET end_s = ?, zh = ?, vi = ? WHERE job_id = ? AND id = ?"),
  insertEmpty: db.prepare("INSERT INTO segments (job_id, id, start_s, end_s, zh, vi, speaker) VALUES (?, ?, ?, ?, '', '', ?)"),
  delete: db.prepare("DELETE FROM segments WHERE job_id = ? AND id = ?"),
  deleteJob: db.prepare("DELETE FROM segments WHERE job_id = ?"),
  markDirty: db.prepare("INSERT INTO timeline_dirty (job_id, rev) VALUES (?, 1) ON CONFLICT(job_id) DO UPDATE SET rev = rev + 1"),
  dirtyRev: db.prepare("SELECT rev FROM timeline_dirty WHERE job_id = ?"),
  clearDirty: db.prepare("DELETE FROM timeline_dirty WHERE job_id = ? AND rev <= ?"),
  dropDirty: db.prepare("DELETE FROM timeline_dirty WHERE job_id = ?"),
};
// Câu lọc thay đổi theo bộ lọc (chỉ câu trống / có từ khóa): 4 tổ hợp, chuẩn bị lần đầu dùng rồi giữ lại.
const filtered = new Map();
function filterStmts(onlyEmpty, hasText) {
  const key = `${onlyEmpty}|${hasText}`;
  if (!filtered.has(key)) {
    const where = ["job_id = ?", ...(onlyEmpty ? ["vi = ''"] : []), ...(hasText ? ["(instr(lc(vi), ?) > 0 OR instr(zh, ?) > 0)"] : [])].join(" AND ");
    filtered.set(key, {
      matched: db.prepare(`SELECT count(*) AS n FROM segments WHERE ${where}`),
      page: db.prepare(`SELECT ${COLS} FROM segments WHERE ${where} ORDER BY start_s, id LIMIT ? OFFSET ?`),
    });
  }
  return filtered.get(key);
}

export const segmentsRepo = {
  /** 1 trang câu thoại + số đếm. text: chữ thường, "" = không lọc. */
  page(jobId, { onlyEmpty, text, limit, offset }) {
    const s = filterStmts(onlyEmpty, Boolean(text));
    const params = text ? [jobId, text, text] : [jobId];
    const { total, empty } = q.totals.get(jobId);
    return { total, empty, matched: s.matched.get(...params).n, items: s.page.all(...params, limit, offset) };
  },
  count: (jobId) => q.count.get(jobId).n,
  firstN: (jobId, n) => q.firstN.all(jobId, n),
  get: (jobId, id) => q.row.get(jobId, id),
  /** Mốc kết thúc của câu đứng trước / mốc bắt đầu của câu đứng sau một mốc giờ (undefined nếu không có). */
  prevEnd: (jobId, start) => q.prevEnd.get(jobId, start)?.end,
  nextStart: (jobId, start) => q.nextStart.get(jobId, start)?.start,
  /** Số câu nằm giữa 2 câu theo thứ tự timeline. */
  countBetween: (jobId, a, b) => q.between.get(jobId, a.start_s, a.id, b.start_s, b.id).n,

  /** Ghi lời dịch / người nói đã sửa ({id: giá trị}) trong 1 giao dịch. */
  applyEdits(jobId, viEdits, speakerEdits) {
    inTransaction(() => {
      for (const [id, vi] of Object.entries(viEdits)) q.setVi.run(String(vi).trim(), jobId, Number(id) || 0);
      for (const [id, spk] of Object.entries(speakerEdits)) q.setSpeaker.run(String(spk), jobId, Number(id) || 0);
    });
  },
  setSpan(jobId, id, start, end, speaker) {
    inTransaction(() => {
      if (speaker === undefined) q.setSpan.run(start, end, jobId, id);
      else q.setSpanSpeaker.run(start, end, String(speaker), jobId, id);
      q.markDirty.run(jobId);
    });
  },
  /** Cắt câu id tại `at`; trả id câu mới (nửa sau, lời để trống). */
  split(jobId, row, at) {
    const newId = (q.maxId.get(jobId).m || 0) + 1;
    inTransaction(() => {
      q.setEnd.run(at, jobId, row.id);
      q.insertEmpty.run(jobId, newId, at, row.end_s, row.speaker);
      q.markDirty.run(jobId);
    });
    return newId;
  },
  /** Ghép second vào first (2 câu liền kề, first đứng trước). */
  merge(jobId, first, second) {
    const join = (a, b) => [a, b].filter(Boolean).join(" ");
    inTransaction(() => {
      q.setMerged.run(second.end_s, join(first.zh, second.zh), join(first.vi, second.vi), jobId, first.id);
      q.delete.run(jobId, second.id);
      q.markDirty.run(jobId);
    });
  },
  /** false nếu không có câu id. */
  remove(jobId, id) {
    return inTransaction(() => {
      if (!q.delete.run(jobId, id).changes) return false;
      q.markDirty.run(jobId);
      return true;
    });
  },
  removeJob(jobId) {
    inTransaction(() => {
      q.deleteJob.run(jobId);
      q.dropDirty.run(jobId);
    });
  },

  /** rev > 0: timeline bị cắt/ghép/xóa/dời giờ sau lần xuất toàn phần gần nhất. */
  dirtyRev: (jobId) => q.dirtyRev.get(jobId)?.rev ?? 0,
  /** Xuất toàn phần xong: xóa cờ nếu không có sửa mới (rev tăng) trong lúc chạy. */
  clearDirty: (jobId, rev) => q.clearDirty.run(jobId, rev),
};
