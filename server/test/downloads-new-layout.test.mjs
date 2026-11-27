/** Bảng 8.5 commit 3: route /downloads/* đi qua chỉ mục video.json; /api/dub/segments trả 3 trường đường dẫn dạng cũ. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { DOWNLOADS_DIR, DUB_WORK_DIR, DUBBED_DIR, ROOT, VIDEOS_DIR } = await import("../config.mjs");
const { writeVideoJson } = await import("../lib/videos.mjs");

const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};
const get = (url, headers = {}, method = "GET") => app.inject({ method, url, headers });
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256));

const KEY = "bilibili-BVdl1-p1";
const V = path.join(VIDEOS_DIR, KEY);
const J = "dub_BVdl1_p1_x_0p5x";
const SRC = path.join(V, "source", "BVdl1_p1_x.mp4");
const SRC_BYTES = bytes(5000, 1);
const OUT_BYTES = bytes(3000, 2);
put(SRC, SRC_BYTES);
put(path.join(V, "jobs", J, "out", `${J}.mp4`), OUT_BYTES);
put(path.join(V, "jobs", J, "out", `${J}.srt`), "1\n00:00:00,000 --> 00:00:01,000\nxin chào\n");
writeVideoJson(KEY, { key: KEY, files: { "downloads/bilibili/BVdl1_p1_x.mp4": "source/BVdl1_p1_x.mp4" }, jobs: [J] });
// Bố cục cũ chạy song song.
put(path.join(DUBBED_DIR, "cu.mp4"), bytes(800, 3));

test("/downloads/... ở bố cục mới: nguồn + bản xuất đúng file, header như static cũ, Range → 206, Range sai → 416, HEAD", async () => {
  const src = await get("/downloads/bilibili/BVdl1_p1_x.mp4");
  assert.equal(src.statusCode, 200);
  assert.ok(src.rawPayload.equals(SRC_BYTES));
  assert.equal(src.headers["content-type"], "video/mp4");
  assert.equal(src.headers["accept-ranges"], "bytes");
  assert.equal(src.headers["content-length"], "5000");
  assert.equal(src.headers["cache-control"], "public, max-age=0");
  assert.ok(src.headers.etag && src.headers["last-modified"]);

  const out = await get(`/downloads/dubbed/${J}.mp4`, { range: "bytes=100-1099" });
  assert.equal(out.statusCode, 206);
  assert.equal(out.headers["content-range"], "bytes 100-1099/3000");
  assert.ok(out.rawPayload.equals(OUT_BYTES.subarray(100, 1100)));
  assert.equal((await get(`/downloads/dubbed/${J}.mp4`, { range: "bytes=999999-" })).statusCode, 416);
  const head = await get(`/downloads/dubbed/${J}.mp4`, {}, "HEAD");
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-length"], "3000");
  assert.equal(head.rawPayload.length, 0);

  const srt = await get(`/downloads/dubbed/${J}.srt`);
  assert.equal(srt.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(srt.body, /xin chào/);

  // Bố cục cũ vẫn phục vụ.
  const cu = await get("/downloads/dubbed/cu.mp4");
  assert.equal(cu.statusCode, 200);
  assert.equal(cu.rawPayload.length, 800);
});

test("/downloads/...: ../, %00, thư mục, file không có, symlink ra ngoài (cả hai bố cục) → 404", async () => {
  put(path.join(dir, "bimat.txt"), "bí mật");
  fs.mkdirSync(path.join(DOWNLOADS_DIR, "bilibili"), { recursive: true });
  fs.symlinkSync(path.join(dir, "bimat.txt"), path.join(DOWNLOADS_DIR, "bilibili", "lienket.mp4"));
  const K2 = "bilibili-BVsl-p1";
  fs.mkdirSync(path.join(VIDEOS_DIR, K2, "source"), { recursive: true });
  fs.symlinkSync(path.join(dir, "bimat.txt"), path.join(VIDEOS_DIR, K2, "source", "sl.mp4"));
  writeVideoJson(K2, { key: K2, files: { "downloads/bilibili/sl.mp4": "source/sl.mp4" }, jobs: [] });
  for (const url of [
    "/downloads/bilibili/lienket.mp4",
    "/downloads/bilibili/sl.mp4",
    "/downloads/%2e%2e/bimat.txt",
    "/downloads/bilibili/%2e%2e/%2e%2e/bimat.txt",
    "/downloads/bilibili/x%00.mp4",
    "/downloads/bilibili",
    "/downloads/dubbed/",
    "/downloads/",
    "/downloads/khong-co.mp4",
  ]) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, url);
    assert.ok(!res.body.includes("bí mật"), url);
  }
});

test("/api/dub/segments trả input_path/work_dir/out_dir dạng cũ khi job ở bố cục mới; file trên đĩa giữ đường dẫn thật", async () => {
  const projFile = path.join(V, "jobs", J, "project.json");
  // input_path tuyệt đối (như file cũ), work_dir/out_dir tương đối theo thư mục dự án (rel_to_base của dub_video.py) hoặc tuyệt đối.
  const stored = {
    job_id: J,
    input_path: SRC,
    voice: "test",
    out_dir: path.relative(ROOT, path.join(V, "jobs", J, "out")),
    work_dir: path.join(V, "jobs", J, "work"),
    speakers: {},
  };
  put(projFile, stored);
  const res = await get(`/api/dub/segments?id=${J}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.input_path, path.join(DOWNLOADS_DIR, "bilibili", "BVdl1_p1_x.mp4"));
  assert.equal(body.work_dir, path.join(DUB_WORK_DIR, J));
  assert.equal(body.out_dir, path.relative(ROOT, DUBBED_DIR));
  assert.deepEqual(Object.keys(body).slice(0, 6), Object.keys(stored)); // giữ thứ tự khóa
  assert.deepEqual(JSON.parse(fs.readFileSync(projFile, "utf8")), stored);

  // Giá trị không trỏ chỗ mới của chính job (vd job mồ côi, nguồn ngoài chỉ mục) thì trả nguyên.
  put(projFile, { ...stored, input_path: "/noi/khac.mp4", work_dir: "data/dub_work/khac" });
  const raw = (await get(`/api/dub/segments?id=${J}`)).json();
  assert.equal(raw.input_path, "/noi/khac.mp4");
  assert.equal(raw.work_dir, "data/dub_work/khac");
});
