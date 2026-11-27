/** Bảng 8.5 commit 2: lưu trữ lồng tiếng đi qua chỉ mục video.json, đọc được cả bố cục cũ lẫn mới. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { DOWNLOADS_DIR, DUBBED_DIR, DUBBED_JSON, VIDEOS_DIR } = await import("../config.mjs");
const store = await import("../modules/dub/repo.mjs");
const { writeVideoJson } = await import("../lib/videos.mjs");

const put = (file, data = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const post = (url, payload) => app.inject({ method: "POST", url, payload });

// Bố cục mới: 1 video, 2 job (0p5x dở 43%, 0p65x đã xuất).
const KEY = "bilibili-BVnew1-p1";
const V = path.join(VIDEOS_DIR, KEY);
const SRC_REL = "downloads/bilibili/BVnew1_p1_a.mp4";
const SRC = path.join(V, "source", "BVnew1_p1_a.mp4");
const J1 = "dub_BVnew1_p1_a_0p5x";
const J2 = "dub_BVnew1_p1_a_0p65x";
put(SRC);
put(path.join(V, "jobs", J1, "work", "meta.json"), { job_id: J1, input_path: SRC, status: "stopped", pct: 43, label: "Đang dịch" });
put(path.join(V, "jobs", J1, "project.json"), { job_id: J1, voice: "test", speakers: {}, input_path: SRC });
put(path.join(V, "jobs", J2, "project.json"), { job_id: J2, voice: "test", speakers: {}, input_path: SRC });
put(path.join(V, "jobs", J2, "out", `${J2}.mp4`));
put(path.join(V, "jobs", J2, "out", `${J2}.srt`));
put(path.join(V, "jobs", J2, "work", "meta.json"), { job_id: J2, input_path: SRC, status: "done", pct: 100 });
writeVideoJson(KEY, { key: KEY, files: { [SRC_REL]: `source/BVnew1_p1_a.mp4` }, jobs: [J1, J2] });
put(DUBBED_JSON, { total: 1, videos: [{ job_id: J2, mp4_file: `${J2}.mp4`, srt_file: `${J2}.srt`, project_id: "" }] });

// Bố cục cũ, chạy song song: meta.json còn ghi đường dẫn cũ dạng tuyệt đối.
const OLD_SRC = path.join(DOWNLOADS_DIR, "bilibili", "BVold_p1_b.mp4");
put(OLD_SRC);
put(path.join(dir, "dub_work", "dub_BVold_p1_b_0p5x", "meta.json"), { job_id: "dub_BVold_p1_b_0p5x", input_path: OLD_SRC, status: "stopped", pct: 12 });

test("lồng tiếng chính bản xuất bị chặn ở bố cục mới (và cũ); gán dự án / xóa nguồn cũng chặn bản xuất", async () => {
  put(path.join(DUBBED_DIR, "cu.mp4"));
  for (const rel of [`downloads/dubbed/${J2}.mp4`, "downloads/dubbed/cu.mp4"]) {
    const res = await post("/api/dub/start", { rel_path: rel });
    assert.equal(res.statusCode, 400, rel);
    assert.match(res.json().error, /File video nguồn không hợp lệ/);
    assert.equal((await post("/api/source/assign", { rel_path: rel, project_id: "" })).statusCode, 400, rel);
    assert.equal((await post("/api/source/delete", { rel_path: rel })).statusCode, 400, rel);
  }
  assert.ok(fs.existsSync(path.join(V, "jobs", J2, "out", `${J2}.mp4`)));
});

test('trạng thái "đang dở x%" ghép theo rel_path ở cả hai bố cục, kể cả meta ghi đường dẫn cũ sau khi file đã chuyển', async () => {
  put(path.join(V, "jobs", J2, "work", "meta.json"), { job_id: J2, input_path: SRC }); // không có status: không tính
  assert.equal(store.readDubJobs().get(SRC_REL).pct, 43);
  assert.equal(store.readDubJobs().get(SRC_REL).job_id, J1);
  assert.equal(store.readDubJobs().get("downloads/bilibili/BVold_p1_b.mp4").pct, 12);
  // meta.json còn ghi đường dẫn cũ downloads/bilibili/... (file đã chuyển vào data/videos): vẫn ra đúng video.
  put(path.join(V, "jobs", J1, "work", "meta.json"), { job_id: J1, input_path: path.join(DOWNLOADS_DIR, "bilibili", "BVnew1_p1_a.mp4"), status: "stopped", pct: 43, error: "loi cu" });
  assert.equal(store.readDubJobs().get(SRC_REL).pct, 43);

  // dub_video của MausBot (dubJobOf) cũng ghép theo rel_path: rel viết khác dạng vẫn ra đúng job.
  const { DUB_FUNCTIONS } = await import("../modules/dub/functions.mjs");
  const fn = DUB_FUNCTIONS.find((f) => f.name === "dub_video");
  assert.equal(fn.fail({ rel_path: "downloads/bilibili/./BVnew1_p1_a.mp4" }), "loi cu");
  assert.equal(fn.result({ rel_path: SRC_REL }).job_id, J1);
  assert.deepEqual(fn.result({ rel_path: "../ngoai.mp4" }), {});

  // /api/sources (bố cục cũ) vẫn hiện job dở.
  const src = (await app.inject({ method: "GET", url: "/api/sources" })).json().sources.find((s) => s.rel_path === "downloads/bilibili/BVold_p1_b.mp4");
  assert.equal(src.job.pct, 12);
});

test("file project, thư mục làm việc, tham số dub_video.py, kết quả trả model đi theo bố cục mới", async () => {
  assert.equal(store.loadDubProject(J1).job_id, J1);
  store.saveDubProject(J1, { job_id: J1, voice: "moi" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(V, "jobs", J1, "project.json"), "utf8")).voice, "moi");
  assert.ok(!fs.existsSync(path.join(dir, "dub_projects", `${J1}.json`)));
  assert.equal(store.dubWorkDirs().get(J1), path.join(V, "jobs", J1, "work"));
  assert.equal(store.dubWorkDir(J1), fs.realpathSync(path.join(V, "jobs", J1, "work")));

  const { createDubService } = await import("../modules/dub/service.mjs");
  const args = createDubService({ loadDubProject: store.loadDubProject }).pathArgs(J1);
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("--job-id"), J1);
  assert.equal(at("--work-dir"), path.join(V, "jobs", J1, "work"));
  assert.equal(at("--out-dir"), path.join(V, "jobs", J1, "out"));
  assert.equal(at("--project-file"), path.join(V, "jobs", J1, "project.json"));

  // /api/dubbed thấy bản xuất ở out/ của job; /api/dub/segments đọc project.json ở bố cục mới.
  const dubbed = (await app.inject({ method: "GET", url: "/api/dubbed" })).json();
  assert.deepEqual(dubbed.videos.map((v) => v.job_id), [J2]);
  assert.equal((await app.inject({ method: "GET", url: `/api/dub/segments?id=${J2}` })).statusCode, 200);
});

test("thư mục làm việc ở bố cục mới: symlink sang job khác / ra ngoài thì không xóa; xóa job chỉ xóa trong jobs/<job>", () => {
  // work của J3 là symlink sang work của J1: không được nhận là của J3.
  const J3 = "dub_BVnew1_p1_a_1p0x";
  fs.mkdirSync(path.join(V, "jobs", J3), { recursive: true });
  fs.symlinkSync(path.join(V, "jobs", J1, "work"), path.join(V, "jobs", J3, "work"));
  writeVideoJson(KEY, { key: KEY, files: { [SRC_REL]: "source/BVnew1_p1_a.mp4" }, jobs: [J1, J2, J3] });
  assert.equal(store.dubWorkDir(J3), null);
  store.removeDubWorkDir(J3);
  assert.ok(fs.existsSync(path.join(V, "jobs", J1, "work", "meta.json")));

  // Xóa hẳn J2: out/, project.json, work/ của J2 mất; nguồn, J1 và bản xuất cũ còn nguyên.
  store.removeDubJob(J2);
  for (const f of [`out/${J2}.mp4`, `out/${J2}.srt`, "project.json", "work"]) assert.ok(!fs.existsSync(path.join(V, "jobs", J2, f)), f);
  assert.ok(fs.existsSync(SRC));
  assert.ok(fs.existsSync(path.join(V, "jobs", J1, "project.json")));
  assert.ok(fs.existsSync(path.join(DUBBED_DIR, "cu.mp4")));
  assert.deepEqual(store.readDubbed(), []);
});

test("đổi giọng Edge lúc khởi động quét cả project.json và work/meta.json ở bố cục mới", async () => {
  const { runMigrations } = await import("../lib/migrate.mjs");
  put(path.join(V, "jobs", J1, "project.json"), { job_id: J1, voice: "vi-VN-NamMinhNeural", speakers: {} });
  put(path.join(V, "jobs", J1, "work", "meta.json"), { job_id: J1, input_path: SRC, params: { voice: "vi-VN-HoaiMyNeural" } });
  runMigrations();
  const proj = fs.readFileSync(path.join(V, "jobs", J1, "project.json"), "utf8");
  assert.equal(JSON.parse(proj).voice, "vieneu:Thiện Minh");
  assert.ok(!proj.includes("\n"), "project.json ghi gọn như dub_projects/");
  assert.equal(JSON.parse(fs.readFileSync(path.join(V, "jobs", J1, "work", "meta.json"), "utf8")).params.voice, "vieneu:Ngọc Huyền");
});
