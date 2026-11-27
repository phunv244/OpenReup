/** API sửa câu thoại của timeline editor: /api/dub/segment/{update,split,merge,delete} + /api/dub/outline. */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { seedJob, segs, setupApp } from "./helpers.mjs";

const { app, db, dir, cleanup } = await setupApp();
after(cleanup);

const JOB = "job_test";
const SPANS = [[0, 1], [1.5, 2.5], [3, 4], [4.5, 5.5], [6, 7]];
beforeEach(() => seedJob(db, dir, JOB, SPANS));

const post = (url, payload) => app.inject({ method: "POST", url, payload });

test("outline trả đủ câu theo thứ tự thời gian", async () => {
  const res = await app.inject({ method: "GET", url: `/api/dub/outline?id=${JOB}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 5);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.items.map((s) => s.id), [1, 2, 3, 4, 5]);
});

test("outline: job không tồn tại → 404", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/dub/outline?id=nope" })).statusCode, 404);
});

test("merge 2 câu liền kề (đảo thứ tự id cũng cho cùng kết quả)", async () => {
  const res = await post("/api/dub/segment/merge", { job_id: JOB, id: 3, with_id: 2 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, 2);
  const rows = segs(db, JOB);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { id: 2, start: 1.5, end: 4, zh: "zh2 zh3", vi: "vi2 vi3" });
});

test("merge 2 câu cách xa → 400, dữ liệu không đổi", async () => {
  const before = segs(db, JOB);
  const res = await post("/api/dub/segment/merge", { job_id: JOB, id: 1, with_id: 4 });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /liền kề/);
  assert.deepEqual(segs(db, JOB), before);
});

test("merge câu với chính nó → 400", async () => {
  assert.equal((await post("/api/dub/segment/merge", { job_id: JOB, id: 2, with_id: 2 })).statusCode, 400);
});

test("merge id không tồn tại → 404", async () => {
  assert.equal((await post("/api/dub/segment/merge", { job_id: JOB, id: 2, with_id: 99 })).statusCode, 404);
});

test("split giữa câu tạo câu mới id = max+1, lời trống", async () => {
  const res = await post("/api/dub/segment/split", { job_id: JOB, id: 2, at: 2 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().second_id, 6);
  const rows = segs(db, JOB);
  assert.deepEqual(rows.slice(1, 3), [
    { id: 2, start: 1.5, end: 2, zh: "zh2", vi: "vi2" },
    { id: 6, start: 2, end: 2.5, zh: "", vi: "" },
  ]);
});

test("split sát đầu/cuối câu (<0,05s) → 400", async () => {
  assert.equal((await post("/api/dub/segment/split", { job_id: JOB, id: 2, at: 1.52 })).statusCode, 400);
  assert.equal((await post("/api/dub/segment/split", { job_id: JOB, id: 2, at: 2.48 })).statusCode, 400);
  assert.equal(segs(db, JOB).length, 5);
});

test("update kéo mép chạm câu bên cạnh → tự kẹp lại", async () => {
  const res = await post("/api/dub/segment/update", { job_id: JOB, id: 3, start: 2, end: 5 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ start: res.json().start, end: res.json().end }, { start: 2.5, end: 4.5 });
});

test("update mốc giờ sai → 400", async () => {
  assert.equal((await post("/api/dub/segment/update", { job_id: JOB, id: 3, start: 4, end: 3 })).statusCode, 400);
  assert.equal((await post("/api/dub/segment/update", { job_id: JOB, id: 3, start: "abc" })).statusCode, 400);
});

test("update id không tồn tại → 404", async () => {
  assert.equal((await post("/api/dub/segment/update", { job_id: JOB, id: 99, start: 0, end: 1 })).statusCode, 404);
});

test("delete câu tồn tại / không tồn tại", async () => {
  assert.equal((await post("/api/dub/segment/delete", { job_id: JOB, id: 3 })).statusCode, 200);
  assert.deepEqual(segs(db, JOB).map((s) => s.id), [1, 2, 4, 5]);
  assert.equal((await post("/api/dub/segment/delete", { job_id: JOB, id: 3 })).statusCode, 404);
});

test("job_id chứa ký tự lạ (path traversal) bị từ chối", async () => {
  assert.equal((await post("/api/dub/segment/delete", { job_id: "../../etc", id: 1 })).statusCode, 400);
});

test("/api/functions: merge_segments cách xa trả lỗi, liền kề thì xong", async () => {
  const bad = (await post("/api/functions/call", { name: "merge_segments", arguments: { job_id: JOB, id: 1, with_id: 4 } })).json();
  assert.equal(bad.status, "error");
  assert.match(bad.error, /liền kề/);
  const good = (await post("/api/functions/call", { name: "merge_segments", arguments: { job_id: JOB, id: 1, with_id: 2 } })).json();
  assert.equal(good.status, "done");
  assert.equal(segs(db, JOB).length, 4);
});

test("/api/functions: tham số sai kiểu / thiếu / hàm lạ bị từ chối", async () => {
  const wrongType = (await post("/api/functions/call", { name: "delete_segment", arguments: { job_id: JOB, id: "3" } })).json();
  assert.equal(wrongType.status, "error");
  const missing = (await post("/api/functions/call", { name: "split_segment", arguments: { job_id: JOB, id: 2 } })).json();
  assert.match(missing.error, /Thiếu tham số/);
  const unknown = (await post("/api/functions/call", { name: "no_such_fn", arguments: {} })).json();
  assert.equal(unknown.ok, false);
  assert.equal(segs(db, JOB).length, 5);
});

test("/api/functions liệt kê đủ hàm segment", async () => {
  const names = (await app.inject({ method: "GET", url: "/api/functions" })).json().functions.map((f) => f.function?.name ?? f.name);
  for (const n of ["list_segments_outline", "edit_segment", "split_segment", "merge_segments", "delete_segment"]) {
    if (!names.includes(n)) assert.fail(`thiếu hàm ${n}; có: ${names.join(", ")}`);
  }
});
