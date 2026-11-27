/** Cờ "timeline đã đổi": sau split/merge/delete/update câu, lần xuất lại phải làm cả hình lẫn tiếng (không --only); xuất xong thì xóa cờ. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { seedJob, setupApp } from "./helpers.mjs";

// Python giả: không dựng video thật, chỉ thoát với mã FAKE_EXIT (đọc lúc chạy nên đổi được giữa các test).
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "reup-fakepy-"));
const fakePy = path.join(binDir, "fakepy");
fs.writeFileSync(fakePy, '#!/bin/sh\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });

const { app, db, dir, cleanup } = await setupApp({ REUP_PYTHON: fakePy });
const { taskEvents } = await import("../lib/tasks.mjs");
after(async () => {
  await cleanup();
  fs.rmSync(binDir, { recursive: true, force: true });
});

const JOB = "job_dirty";
beforeEach(() => {
  process.env.FAKE_EXIT = "0";
  seedJob(db, dir, JOB, [[0, 1], [1.5, 2.5], [3, 4]]);
  db.prepare("DELETE FROM timeline_dirty WHERE job_id = ?").run(JOB);
});

const post = (url, payload) => app.inject({ method: "POST", url, payload });
const dirty = () => Boolean(db.prepare("SELECT 1 FROM timeline_dirty WHERE job_id = ?").get(JOB));

/** Gọi xuất lại rồi chờ tiến trình (giả) kết thúc; trả dòng lệnh đã chạy + mã thoát. */
async function rerender(body) {
  const ended = new Promise((resolve) => taskEvents.once("end", resolve));
  const res = await post("/api/dub/rerender", { job_id: JOB, ...body });
  assert.equal(res.statusCode, 200, res.body);
  const ev = await ended;
  return { cmd: ev.logs.find((l) => l.includes("Bắt đầu:")), exit: ev.exit_code };
}

test("không đổi timeline: chỉ đổi phụ đề → --only video, đổi âm lượng → --only audio", async () => {
  assert.match((await rerender({ burn_sub: false })).cmd, /--only video/);
  assert.match((await rerender({ bg_volume: 0.5 })).cmd, /--only audio/);
});

const EDITS = {
  split: ["/api/dub/segment/split", { id: 2, at: 2 }],
  merge: ["/api/dub/segment/merge", { id: 1, with_id: 2 }],
  delete: ["/api/dub/segment/delete", { id: 3 }],
  update: ["/api/dub/segment/update", { id: 2, start: 1.6 }],
};

for (const [name, [url, payload]] of Object.entries(EDITS)) {
  test(`${name} câu → lần xuất lại kế tiếp làm toàn bộ, xuất xong thì xóa cờ`, async () => {
    const r = await post(url, { job_id: JOB, ...payload });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(dirty());
    // Chỉ đổi kiểu phụ đề vẫn phải dựng lại tiếng vì câu đã đổi.
    const run = await rerender({ burn_sub: false });
    assert.doesNotMatch(run.cmd, /--only/);
    assert.equal(run.exit, 0);
    assert.ok(!dirty());
    // Cờ đã xóa: lần sau lại được tối ưu như cũ.
    assert.match((await rerender({ bg_volume: 0.3 })).cmd, /--only audio/);
  });
}

test("sửa qua /api/functions (delete_segment) cũng bật cờ", async () => {
  const r = await post("/api/functions/call", { name: "delete_segment", arguments: { job_id: JOB, id: 1 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(dirty());
  assert.doesNotMatch((await rerender({ burn_sub: false })).cmd, /--only/);
});

test("xuất lại bị lỗi → giữ cờ, lần sau vẫn làm toàn bộ", async () => {
  await post("/api/dub/segment/delete", { job_id: JOB, id: 2 });
  process.env.FAKE_EXIT = "1";
  const failed = await rerender({ burn_sub: false });
  assert.equal(failed.exit, 1);
  assert.ok(dirty());
  process.env.FAKE_EXIT = "0";
  assert.doesNotMatch((await rerender({ burn_sub: true })).cmd, /--only/);
  assert.ok(!dirty());
});

test("thao tác bị từ chối (404/400) không bật cờ", async () => {
  await post("/api/dub/segment/delete", { job_id: JOB, id: 99 });
  await post("/api/dub/segment/merge", { job_id: JOB, id: 1, with_id: 3 });
  await post("/api/dub/segment/split", { job_id: JOB, id: 1, at: 0.01 });
  assert.ok(!dirty());
});
