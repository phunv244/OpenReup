/** Module sources: API video nguồn trên thư mục tạm + file tải về (SAVED_FILE:::) tính theo REUP_MEDIA_ROOT. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

// setupApp trước mọi import của server (config.mjs đọc biến môi trường lúc nạp).
const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { DOWNLOADS_DIR, ROOT } = await import("../config.mjs");
const { spawnTask, taskEvents } = await import("../lib/tasks.mjs");
const { projectRepo } = await import("../modules/project/repo.mjs");
const readVideoProjects = () => projectRepo.owners();
const { MODULES } = await import("../app.mjs");

const get = (url) => app.inject({ method: "GET", url });
const post = (url, payload) => app.inject({ method: "POST", url, payload });
const put = (file, data = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};

test("module sources khai deps dub + project, không còn route bọc server/routes/sources.mjs", () => {
  const m = MODULES.find((x) => x.name === "sources");
  assert.deepEqual(m.deps, ["dub", "project"]);
  assert.ok(!MODULES.some((x) => x.name === "source"));
  assert.ok(!fs.existsSync(path.join(ROOT, "server", "routes", "sources.mjs")));
});

test("GET /api/sources liệt kê video trong downloads/ tạm (rel_path, project_id), bỏ file tạm xóa logo", async () => {
  put(path.join(DOWNLOADS_DIR, "bilibili", "a.mp4"));
  put(path.join(DOWNLOADS_DIR, "bilibili", "b.delogo_tmp.mp4"));
  put(path.join(DOWNLOADS_DIR, "dy.mp4"));
  put(path.join(dir, "projects", "p1.json"), { id: "p1", name: "P1" });
  assert.equal((await post("/api/source/assign", { rel_path: "downloads/bilibili/a.mp4", project_id: "p1" })).statusCode, 200);
  const res = await get("/api/sources");
  assert.equal(res.statusCode, 200);
  const byRel = Object.fromEntries(res.json().sources.map((s) => [s.rel_path, s]));
  assert.deepEqual(Object.keys(byRel).sort(), ["downloads/bilibili/a.mp4", "downloads/dy.mp4"]);
  assert.equal(byRel["downloads/bilibili/a.mp4"].source, "bilibili");
  assert.equal(byRel["downloads/bilibili/a.mp4"].project_id, "p1");
  assert.equal(byRel["downloads/dy.mp4"].source, "douyin");
});

test("lỗi ở biên: gán dự án không có -> 404, video không có -> 400, xóa ngoài downloads -> 400, link sai -> 400", async () => {
  const cases = [
    ["/api/source/assign", { rel_path: "downloads/bilibili/a.mp4", project_id: "khong-co" }, 404],
    ["/api/source/assign", { rel_path: "downloads/khong-co.mp4", project_id: "" }, 400],
    ["/api/source/assign", { rel_path: "../etc/passwd" }, 400],
    ["/api/source/delete", { rel_path: "downloads/dubbed/x.mp4" }, 400],
    ["/api/source/delete", { rel_path: "downloads/bilibili" }, 400],
    ["/api/source/delete", { rel_path: "downloads" }, 400],
    ["/api/bilibili/download", { url: "ftp://x" }, 400],
    ["/api/bilibili/download", { url: "https://b.tv/x", delogo: "rm -rf" }, 400],
    ["/api/bilibili/delogo", {}, 400],
    ["/api/status", { key: "x" }, 404],
  ];
  for (const [url, body, code] of cases) {
    const res = await post(url, body);
    assert.equal(res.statusCode, code, `${url} ${JSON.stringify(body)}: ${res.body}`);
    assert.equal(res.json().ok, false);
    assert.ok(res.json().error);
  }
});

test("POST /api/status đánh dấu video Douyin; /api/videos trả local_file theo aweme_id", async () => {
  put(path.join(dir, "videos.json"), { videos: [{ aweme_id: "123", title: "t" }] });
  put(path.join(DOWNLOADS_DIR, "x_123.mp4"));
  assert.deepEqual((await post("/api/status", { key: "123", status: "done" })).json(), { ok: true });
  assert.deepEqual((await post("/api/status", { key: "999" })).json(), { ok: false });
  const v = (await get("/api/videos")).json().videos[0];
  assert.equal(v.reup_status, "done");
  assert.equal(v.local_file, "x_123.mp4");
});

test("xóa video nguồn: xóa file + .info.json + mục bilibili.json + gán dự án", async () => {
  const src = path.join(DOWNLOADS_DIR, "bilibili", "del.mp4");
  put(src);
  put(src.replace(/\.mp4$/, ".info.json"));
  put(path.join(dir, "bilibili.json"), { videos: [{ local_file: "del.mp4" }, { local_file: "a.mp4" }] });
  await post("/api/source/assign", { rel_path: "downloads/bilibili/del.mp4", project_id: "p1" });
  const res = await post("/api/source/delete", { rel_path: "downloads/bilibili/del.mp4" });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!fs.existsSync(src) && !fs.existsSync(src.replace(/\.mp4$/, ".info.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "bilibili.json"), "utf8")).videos.map((v) => v.local_file), ["a.mp4"]);
  assert.ok(!("downloads/bilibili/del.mp4" in readVideoProjects()));
});

test("file tải về (SAVED_FILE:::) tính theo REUP_MEDIA_ROOT: đường dẫn tương đối và tuyệt đối đều gán vào dự án", async () => {
  const abs = path.join(DOWNLOADS_DIR, "bilibili", "abs.mp4");
  const code = `console.log("SAVED_FILE:::downloads/rel.mp4"); console.log(${JSON.stringify("SAVED_FILE:::" + abs)}); console.log("SAVED_FILE:::/etc/passwd");`;
  const ended = new Promise((resolve) => taskEvents.once("end", resolve));
  assert.equal(spawnTask("download", process.execPath, ["-e", code], "", "p1").ok, true);
  const ev = await ended;
  assert.deepEqual(ev.saved_files, [path.join(DOWNLOADS_DIR, "rel.mp4"), abs]);
  const owners = readVideoProjects();
  assert.equal(owners["downloads/rel.mp4"], "p1");
  assert.equal(owners["downloads/bilibili/abs.mp4"], "p1");
});
