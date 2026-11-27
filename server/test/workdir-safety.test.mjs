/** Xóa thư mục làm việc an toàn (xóa video nguồn, /api/dub/clean) + test không ghi vào data/ hay downloads/ thật. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

// setupApp trước mọi import của server (config.mjs đọc biến môi trường lúc nạp).
const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { DOWNLOADS_DIR, DUBBED_DIR, ROOT } = await import("../config.mjs");
const { dubWorkDir, removeDubWorkDir } = await import("../lib/store.mjs");

const W = path.join(dir, "dub_work");
const post = (url, payload) => app.inject({ method: "POST", url, payload });
const put = (file, data = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
/** Video nguồn + job lồng tiếng đang dở của nó (meta.json trong workDir). */
const pendingSource = (name, workDir, jobId) => {
  const src = path.join(DOWNLOADS_DIR, "bilibili", `${name}.mp4`);
  put(src);
  put(path.join(workDir, "meta.json"), { job_id: jobId, input_path: src, status: "stopped" });
  return `downloads/bilibili/${name}.mp4`;
};

test("thư mục xuất (downloads/, downloads/dubbed) nằm trong thư mục tạm của test, không phải repo", () => {
  assert.equal(DOWNLOADS_DIR, path.join(dir, "downloads"));
  assert.equal(DUBBED_DIR, path.join(dir, "downloads", "dubbed"));
  assert.ok(!DUBBED_DIR.startsWith(ROOT + path.sep));
});

test('xóa video nguồn: job_id "." hoặc "../projects" trong meta.json không xóa gì', async () => {
  put(path.join(dir, "projects", "p.json"), "{}");
  put(path.join(W, "job_khac", "keep.txt"));
  for (const [name, jobId] of [["dot", "."], ["dotdot", "../projects"]]) {
    const work = path.join(W, `job_${name}`);
    const rel = pendingSource(name, work, jobId);
    const res = await post("/api/source/delete", { rel_path: rel });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!fs.existsSync(path.join(dir, rel)), "file nguồn phải bị xóa");
    assert.ok(fs.existsSync(path.join(work, "meta.json")), `job_id ${jobId}: không được xóa gì`);
  }
  assert.ok(fs.existsSync(path.join(dir, "projects", "p.json")), "data/projects bị xóa");
  assert.ok(fs.existsSync(path.join(W, "job_khac", "keep.txt")), "data/dub_work bị xóa");
});

test("xóa video nguồn: job có work_dir riêng (đã chuyển chỗ) thì xóa đúng thư mục đó", async () => {
  const moved = path.join(W, "luu_tru", "job_moved");
  const rel = pendingSource("moved", moved, "job_moved");
  put(path.join(W, "job_moved", "keep.txt")); // thư mục cùng tên ở chỗ mặc định: không phải của job này nữa
  put(path.join(dir, "dubbed.json"), { videos: [{ job_id: "job_moved", work_dir: moved }] });
  try {
    assert.equal((await post("/api/source/delete", { rel_path: rel })).statusCode, 200);
    assert.ok(!fs.existsSync(moved), "work_dir riêng phải bị xóa");
    assert.ok(fs.existsSync(path.join(W, "job_moved", "keep.txt")));
    assert.ok(fs.existsSync(path.join(W, "luu_tru")));
  } finally {
    fs.rmSync(path.join(dir, "dubbed.json"), { force: true });
  }
});

test("work_dir của job A trỏ vào thư mục job B: không xóa (tên thư mục phải đúng job_id)", async () => {
  put(path.join(W, "job_b", "keep.txt"));
  put(path.join(dir, "dubbed.json"), { videos: [{ job_id: "job_a", work_dir: path.join(W, "job_b") }] });
  try {
    assert.equal(dubWorkDir("job_a"), null);
    assert.equal((await post("/api/dub/clean", { job_id: "job_a" })).statusCode, 200);
    assert.ok(fs.existsSync(path.join(W, "job_b", "keep.txt")), "thư mục của job B bị xóa");
  } finally {
    fs.rmSync(path.join(dir, "dubbed.json"), { force: true });
  }
});

test("thư mục job không có / đã biến mất: trả null, không ném lỗi", () => {
  assert.equal(dubWorkDir("khong_co"), null);
  assert.doesNotThrow(() => removeDubWorkDir("khong_co"));
  fs.symlinkSync(path.join(W, "da_xoa"), path.join(W, "job_gay")); // symlink hỏng: realpath ném ENOENT
  assert.equal(dubWorkDir("job_gay"), null);
});
