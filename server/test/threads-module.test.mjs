/** Kiểm thử module Threads: SQLite WAL threads_jobs, validation 0–200%, spawnTask GPU queue, /api/functions. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const fakeCliDir = fs.mkdtempSync(path.join("/tmp", "threads-fake-cli-"));
const fakeCliPath = path.join(fakeCliDir, "cli.js");
fs.writeFileSync(
  fakeCliPath,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const outIdx = args.indexOf("--output");
const outPath = outIdx >= 0 ? args[outIdx + 1] : "";
console.log('@@PROGRESS {"pct":50,"label":"Fake Threads worker","stage":3,"eta":null}');
if (outPath) {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, "FAKE_MP4");
  const mediaRoot = process.env.REUP_MEDIA_ROOT || process.cwd();
  const rel = path.relative(mediaRoot, outPath).split(path.sep).join("/");
  console.log("SAVED_FILE:::" + rel);
}
console.log('@@RESULT ' + JSON.stringify({ ok: true, data: { mode: args[0], args } }));
`,
  { mode: 0o755 },
);

const { app, cleanup } = await setupApp({ REUP_THREADS_CLI: fakeCliPath });
after(async () => {
  await cleanup();
  fs.rmSync(fakeCliDir, { recursive: true, force: true });
});

test("POST /api/threads/reup từ chối original_audio_volume_pct ngoài biên 0–200 (ERR_VALIDATION_FAILED)", async () => {
  for (const bad of [-1, 201, 999]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/threads/reup",
      payload: {
        url: "https://www.threads.net/@demo/post/ABC123",
        original_audio_volume_pct: bad,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /ERR_VALIDATION_FAILED/);
  }
});

test("POST /api/threads/reup từ chối font_name injection (ERR_VALIDATION_FAILED)", async () => {
  for (const badFont of ["Arial',drawbox=x=0:y=0", "Font:Outline=9", "A".repeat(65)]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/threads/reup",
      payload: {
        url: "https://www.threads.net/@demo/post/ABC123",
        font_name: badFont,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /ERR_VALIDATION_FAILED/);
  }
});

test("POST /api/threads/video từ chối URL không phải Threads (ERR_INVALID_URL)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/threads/video",
    payload: { url: "https://example.com/not-threads" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /ERR_INVALID_URL/);
});

test("POST /api/threads/reup chạy qua spawnTask, ghi SQLite threads_jobs và cập nhật trạng thái done + output_rel_path", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/threads/reup",
    payload: {
      url: "https://www.threads.net/@demo/post/XYZ789",
      original_audio_volume_pct: 150,
      delogo: "10,10,40,40",
      subcover: "10,500,300,60",
      burn_sub: true,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.job_id);
  assert.equal(body.job.params.original_audio_volume_pct, 150);

  // Chờ tiến trình giả kết thúc
  await new Promise((r) => setTimeout(r, 400));

  const detail = await app.inject({ method: "GET", url: `/api/threads/jobs/${body.job_id}` });
  assert.equal(detail.statusCode, 200);
  const job = detail.json().job;
  assert.equal(job.status, "done");
  assert.match(job.output_rel_path, /^downloads\/threads\/rt_/);

  const list = await app.inject({ method: "GET", url: "/api/threads/jobs" });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().jobs.some((j) => j.id === body.job_id));

  const del = await app.inject({ method: "DELETE", url: `/api/threads/jobs/${body.job_id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);
});

test("GET /api/functions chứa đủ 4 hàm của module threads và gọi được threads_list_jobs", async () => {
  const fnRes = await app.inject({ method: "GET", url: "/api/functions" });
  const names = fnRes.json().functions.map((f) => f.function.name);
  for (const expected of [
    "threads_video_pipeline",
    "threads_reup_pipeline",
    "threads_scrape_post",
    "threads_list_jobs",
  ]) {
    assert.ok(names.includes(expected), `Thiếu hàm ${expected} trong /api/functions`);
  }

  const callRes = await app.inject({
    method: "POST",
    url: "/api/functions/call",
    payload: { name: "threads_list_jobs", arguments: { limit: 10 } },
  });
  assert.equal(callRes.statusCode, 200);
  assert.equal(callRes.json().status, "done");
  assert.ok(Array.isArray(callRes.json().result.jobs));
});
