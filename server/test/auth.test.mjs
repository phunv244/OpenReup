/** REUP_API_TOKEN: request ghi vào /api/ phải có Bearer token; GET vẫn mở; /api/functions gọi nội bộ vẫn chạy. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { seedJob, segs, setupApp } from "./helpers.mjs";

const TOKEN = "test-token-123";
const { app, db, dir, cleanup } = await setupApp({ REUP_API_TOKEN: TOKEN });
after(cleanup);
seedJob(db, dir, "job_auth", [[0, 1], [1.5, 2.5], [3, 4]]);
const del = (headers) => app.inject({ method: "POST", url: "/api/dub/segment/delete", headers, payload: { job_id: "job_auth", id: 3 } });

test("POST không token / sai token → 401, dữ liệu không đổi", async () => {
  assert.equal((await del({})).statusCode, 401);
  assert.equal((await del({ authorization: "Bearer wrong" })).statusCode, 401);
  assert.equal(segs(db, "job_auth").length, 3);
});

test("GET không cần token", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/dub/outline?id=job_auth" })).statusCode, 200);
});

test("POST đúng token → chạy", async () => {
  assert.equal((await del({ authorization: `Bearer ${TOKEN}` })).statusCode, 200);
  assert.equal(segs(db, "job_auth").length, 2);
});

test("/api/functions/call có token → route bên trong không bị 401", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/functions/call", headers: { authorization: `Bearer ${TOKEN}` },
    payload: { name: "merge_segments", arguments: { job_id: "job_auth", id: 1, with_id: 2 } },
  });
  assert.equal(res.json().status, "done", res.body);
});
