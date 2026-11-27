/** Bảng 8.5 commit 5: /api/sources, /api/thumb, xóa video nguồn đọc cả bố cục mới (data/videos/<key>/source/) lẫn downloads/ cũ. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { VIDEOS_DIR, THUMBS_DIR, MEDIA_CACHE_JSON } = await import("../config.mjs");
const { reloadVideoIndex } = await import("../lib/videos.mjs");

const put = (file, body = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const get = (url) => app.inject({ method: "GET", url });

const KEY = "bilibili-BVnew-p1";
const VDIR = path.join(VIDEOS_DIR, KEY);
const NEW_REL = "downloads/bilibili/BVnew_p1_.mp4";
const NEW_SRC = path.join(VDIR, "source", "BVnew_p1_.mp4");
const DUP_REL = "downloads/bilibili/BVdup_p1_.mp4"; // có cả ở downloads/ cũ lẫn trong chỉ mục
const KEY2 = "bilibili-BVdup-p1";
const VDIR2 = path.join(VIDEOS_DIR, KEY2);
const OLD_REL = "downloads/bilibili/BVold_p1_.mp4";
const DOUYIN_REL = "downloads/7300000000000000001.mp4";
const THUMB = Buffer.from("anh-thumb-jpg");

test("dựng fixture hai bố cục", () => {
  put(path.join(dir, OLD_REL), "old");
  put(path.join(dir, DOUYIN_REL), "douyin");
  put(path.join(dir, DUP_REL), "ban-cu-bi-che");
  put(path.join(dir, "downloads/bilibili/BVold_p1_.delogo_tmp.mp4"));
  put(path.join(VDIR, "video.json"), {
    key: KEY,
    files: { [NEW_REL]: "source/BVnew_p1_.mp4", "downloads/bilibili/BVnew_p1_.info.json": "source/BVnew_p1_.info.json" },
    jobs: [],
  });
  put(NEW_SRC, "new-video");
  put(path.join(VDIR, "source", "BVnew_p1_.info.json"), "{}");
  put(path.join(VDIR, "thumb.jpg"), THUMB);
  put(path.join(VDIR2, "video.json"), { key: KEY2, files: { [DUP_REL]: "source/BVdup_p1_.mp4" }, jobs: [] });
  put(path.join(VDIR2, "source", "BVdup_p1_.mp4"), "ban-moi-dai-hon");
  reloadVideoIndex();
});

test("GET /api/sources: liệt kê cả mới lẫn cũ, rel_path dạng downloads/..., không trùng, thông tin lấy từ file thật", async () => {
  const res = await get("/api/sources");
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json().sources;
  assert.deepEqual(list.map((s) => s.rel_path).sort(), [DOUYIN_REL, DUP_REL, "downloads/bilibili/BVnew_p1_.mp4", OLD_REL].sort());
  const byRel = Object.fromEntries(list.map((s) => [s.rel_path, s]));
  assert.equal(byRel[NEW_REL].source, "bilibili");
  assert.equal(byRel[NEW_REL].name, "BVnew_p1_.mp4");
  assert.equal(byRel[DOUYIN_REL].source, "douyin");
  // Bản trong chỉ mục được dùng (mtime của file trong data/videos), bản cũ cùng rel_path bị bỏ.
  assert.equal(byRel[DUP_REL].mtime, Math.round(fs.statSync(path.join(VDIR2, "source", "BVdup_p1_.mp4")).mtimeMs));
  // media_cache.json khóa theo rel_path, không theo đường dẫn thật.
  const keys = Object.keys(JSON.parse(fs.readFileSync(MEDIA_CACHE_JSON, "utf8")));
  assert.equal(keys.length, 4);
  for (const k of keys) assert.match(k, /^downloads\//);
});

test("GET /api/sources: video.json ghi file đã mất trên đĩa thì không liệt kê, không lỗi", async () => {
  const k = "bilibili-BVgone-p1";
  put(path.join(VIDEOS_DIR, k, "video.json"), { key: k, files: { "downloads/bilibili/BVgone_p1_.mp4": "source/BVgone_p1_.mp4" }, jobs: [] });
  reloadVideoIndex();
  const res = await get("/api/sources");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().sources.some((s) => s.rel_path === "downloads/bilibili/BVgone_p1_.mp4"), false);
  fs.rmSync(path.join(VIDEOS_DIR, k), { recursive: true });
  reloadVideoIndex();
});

test("GET /api/sources: file nguồn trong chỉ mục là symlink ra ngoài thì không liệt kê, kể cả bản cũ cùng rel_path", async () => {
  const k = "bilibili-BVsym-p1";
  const rel = "downloads/bilibili/BVsym_p1_.mp4";
  const outside = path.join(dir, "ngoai.mp4");
  put(outside, "ngoai");
  put(path.join(dir, rel), "ban-cu");
  put(path.join(VIDEOS_DIR, k, "video.json"), { key: k, files: { [rel]: "source/BVsym_p1_.mp4" }, jobs: [] });
  fs.mkdirSync(path.join(VIDEOS_DIR, k, "source"), { recursive: true });
  fs.symlinkSync(outside, path.join(VIDEOS_DIR, k, "source", "BVsym_p1_.mp4"));
  reloadVideoIndex();
  const res = await get("/api/sources");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().sources.some((s) => s.rel_path === rel), false);
  fs.rmSync(path.join(VIDEOS_DIR, k), { recursive: true });
  fs.rmSync(path.join(dir, rel));
  reloadVideoIndex();
});

test("GET /api/thumb: bố cục mới trả thumb.jpg trong thư mục video", async () => {
  const res = await get(`/api/thumb?rel=${encodeURIComponent(NEW_REL)}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["cache-control"], "max-age=604800");
  assert.deepEqual(res.rawPayload, THUMB);
});

test("GET /api/thumb: không có thumb.jpg thì dùng ảnh cache trong data/thumbs/ khóa theo rel_path", async () => {
  for (const [rel, abs] of [[DUP_REL, path.join(VDIR2, "source", "BVdup_p1_.mp4")], [OLD_REL, path.join(dir, OLD_REL)]]) {
    const st = fs.statSync(abs);
    const name = crypto.createHash("sha1").update(`${rel}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex");
    put(path.join(THUMBS_DIR, `${name}.jpg`), `cache-${rel}`);
    const res = await get(`/api/thumb?rel=${encodeURIComponent(rel)}`);
    assert.equal(res.statusCode, 200, rel);
    assert.equal(res.body, `cache-${rel}`);
  }
});

test("GET /api/thumb: thumb.jpg là symlink ra ngoài thư mục video thì không phục vụ", async () => {
  const outside = path.join(dir, "bi-mat.jpg");
  put(outside, "bi-mat");
  fs.rmSync(path.join(VDIR2, "thumb.jpg"), { force: true });
  fs.symlinkSync(outside, path.join(VDIR2, "thumb.jpg"));
  const res = await get(`/api/thumb?rel=${encodeURIComponent(DUP_REL)}`);
  assert.notEqual(res.body, "bi-mat");
  fs.rmSync(path.join(VDIR2, "thumb.jpg"));
});

test("GET /api/thumb: rel lạ hoặc không phải video nguồn trả 404", async () => {
  for (const rel of ["", "../data/openreup.db", "downloads/bilibili/khong-co.mp4", `data/videos/${KEY}/thumb.jpg`]) {
    const res = await get(`/api/thumb?rel=${encodeURIComponent(rel)}`);
    assert.equal(res.statusCode, 404, rel);
  }
});

test("POST /api/source/delete bố cục mới: xóa file nguồn + .info.json, bỏ khỏi video.json, thư mục video còn nguyên", async () => {
  const res = await app.inject({ method: "POST", url: "/api/source/delete", payload: { rel_path: NEW_REL } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(fs.existsSync(NEW_SRC), false);
  assert.equal(fs.existsSync(path.join(VDIR, "source", "BVnew_p1_.info.json")), false);
  const v = JSON.parse(fs.readFileSync(path.join(VDIR, "video.json"), "utf8"));
  assert.deepEqual(v, { key: KEY, files: {}, jobs: [] });
  assert.equal(fs.existsSync(path.join(VDIR, "thumb.jpg")), true);
  const list = (await get("/api/sources")).json().sources.map((s) => s.rel_path);
  assert.equal(list.includes(NEW_REL), false);
  assert.equal(list.includes(DUP_REL), true);
});

test("POST /api/source/delete: video.json hỏng sau khi dựng chỉ mục thì vẫn xóa file, bỏ gán dự án, trả 200", async () => {
  const k = "bilibili-BVbad-p1";
  const rel = "downloads/bilibili/BVbad_p1_.mp4";
  const src = path.join(VIDEOS_DIR, k, "source", "BVbad_p1_.mp4");
  put(path.join(VIDEOS_DIR, k, "video.json"), { key: k, files: { [rel]: "source/BVbad_p1_.mp4" }, jobs: [] });
  put(src, "bad");
  const { VIDEO_PROJECTS_JSON } = await import("../config.mjs");
  put(VIDEO_PROJECTS_JSON, { [rel]: "du-an-x" });
  reloadVideoIndex();
  assert.equal((await get("/api/sources")).json().sources.find((s) => s.rel_path === rel)?.project_id, "du-an-x");
  // Làm hỏng video.json sau khi chỉ mục đã dựng mà giữ nguyên chữ ký (cùng inode, cỡ, mtime): chỉ mục không dựng
  // lại dù đã quá INDEX_TTL_MS, nên test không phụ thuộc tốc độ máy.
  const vj = path.join(VIDEOS_DIR, k, "video.json");
  const st = fs.statSync(vj);
  const bad = "{hong".padEnd(st.size, " ");
  fs.writeFileSync(vj, bad);
  fs.utimesSync(vj, st.atimeMs / 1000, st.mtimeMs / 1000);
  assert.equal(fs.statSync(vj).mtimeMs, st.mtimeMs);
  assert.equal(fs.statSync(vj).ino, st.ino);
  const res = await app.inject({ method: "POST", url: "/api/source/delete", payload: { rel_path: rel } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(fs.existsSync(src), false);
  assert.equal(rel in JSON.parse(fs.readFileSync(VIDEO_PROJECTS_JSON, "utf8")), false);
  assert.equal(fs.readFileSync(vj, "utf8"), bad);
  fs.rmSync(path.join(VIDEOS_DIR, k), { recursive: true });
  reloadVideoIndex();
});
