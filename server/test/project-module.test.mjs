/** Module project: đếm video (service.stats) theo đúng dữ liệu thật đã gặp lỗi + CRUD qua API cũ. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

// setupApp trước mọi import của server: config.mjs đọc REUP_DATA_DIR lúc nạp, import sớm sẽ ghi vào data/ thật.
const { app, cleanup } = await setupApp();
after(cleanup);
const { createProjectService } = await import("../modules/project/service.mjs");

const B = "downloads/bilibili/";
// Mô phỏng data/ thật ngày 2026-11-27: 1 video nguồn có thể lồng tiếng nhiều lần (0p5x, 0p65x).
const snap = {
  owners: {
    [`${B}BVtest1.mp4`]: "so-tan-cau-ca",
    [`${B}BVtest2.mp4`]: "so-tan-cau-ca",
    [`${B}BV1nHW.mp4`]: "so-tan-cau-ca",
    [`${B}4796733758117388.mp4`]: "cau-ca-van-can",
    [`${B}4795815441340424.mp4`]: "cau-ca-van-can",
    [`${B}da-xoa.mp4`]: "cau-ca-van-can", // file đã mất: không đếm
  },
  dubbed: [
    { job_id: "dub_BVtest1_0p65x", project_id: "so-tan-cau-ca" },
    { job_id: "dub_BVtest1_0p5x", project_id: "so-tan-cau-ca" },
    { job_id: "dub_BVtest2_0p5x", project_id: "so-tan-cau-ca" },
    { job_id: "dub_4795_0p65x", project_id: "cau-ca-van-can" },
    { job_id: "dub_BV1wyx_0p65x", project_id: "cau-ca-van-can" }, // nguồn không gán dự án, vẫn là 1 video của dự án
    { job_id: "dub_4796_0p5x", project_id: "cau-ca-van-can" },
    { job_id: "dub_qasandbox50_0p5x", project_id: "" },
  ],
  dubSources: new Map([
    ["dub_BVtest1_0p65x", `${B}BVtest1.mp4`],
    ["dub_BVtest1_0p5x", `${B}BVtest1.mp4`],
    ["dub_BVtest2_0p5x", `${B}BVtest2.mp4`],
    ["dub_4795_0p65x", `${B}4795815441340424.mp4`],
    ["dub_BV1wyx_0p65x", `${B}BV1wyx.mp4`],
    ["dub_4796_0p5x", `${B}4796733758117388.mp4`],
  ]),
  sourceExists: (rel) => !rel.endsWith("da-xoa.mp4"),
};
// Repo + service dub giả: project chỉ thấy bản lồng tiếng qua service của module dub (ctx.get("dub")).
const fakeRepo = { owners: () => snap.owners, sourceExists: snap.sourceExists };
const fakeDub = (dubSources = snap.dubSources) => ({ list: () => snap.dubbed, sources: () => dubSources });
const svc = createProjectService(fakeRepo, fakeDub());
const counts = (id) => {
  const s = svc.stats(id);
  return [s.video_count, s.dubbed_count, s.pending_count];
};

test("so-tan-cau-ca: 3 video nguồn, 2 đã lồng tiếng (1 video lồng 2 lần), 1 chưa", () => {
  assert.deepEqual(counts("so-tan-cau-ca"), [3, 2, 1]);
  assert.equal(svc.stats("so-tan-cau-ca").videos.length, 3);
});

test("cau-ca-van-can: 3/3/0 (bản lồng tiếng có nguồn chưa gán vẫn tính, nguồn mất file không tính)", () => {
  assert.deepEqual(counts("cau-ca-van-can"), [3, 3, 0]);
});

test("bản lồng tiếng mất meta (không biết nguồn) tự tính là 1 video", () => {
  const dubSources = new Map(snap.dubSources);
  dubSources.delete("dub_BVtest2_0p5x"); // BVtest2 thành "chưa lồng tiếng", bản lồng tiếng của nó thành 1 video riêng
  const s = createProjectService(fakeRepo, fakeDub(dubSources)).stats("so-tan-cau-ca");
  assert.deepEqual([s.video_count, s.dubbed_count, s.pending_count], [4, 2, 2]);
});

const post = async (url, payload) => (await app.inject({ method: "POST", url, payload })).json();

test("API /api/projects giữ nguyên: tạo, sửa, liệt kê kèm số đếm, xóa, lỗi đầu vào", async () => {
  assert.deepEqual(await post("/api/projects", { name: "  " }), { ok: false, error: "Vui lòng nhập tên dự án." });
  const { project } = await post("/api/projects", { name: "Sơ tán câu cá", voice: "sai" });
  assert.equal(project.id, "so-tan-cau-ca");
  assert.equal(project.voice, "");
  assert.equal((await post("/api/projects", { name: "Sơ tán câu cá" })).project.id, "so-tan-cau-ca-2");
  const saved = await post("/api/projects/save", { id: "so-tan-cau-ca", synopsis: "abc", characters: [{ zh: "甲", vi: "Giáp", voice: "x" }] });
  assert.equal(saved.project.synopsis, "abc");
  assert.deepEqual(saved.project.characters[0], { zh: "甲", vi: "Giáp" }); // field lạ (voice) bị bỏ
  const miss = await app.inject({ method: "POST", url: "/api/projects/save", payload: { id: "khong-co" } });
  assert.equal(miss.statusCode, 404);
  assert.deepEqual(miss.json(), { ok: false, error: "Không tìm thấy dự án." });
  const list = (await app.inject({ url: "/api/projects" })).json();
  assert.equal(list.total, 2);
  assert.deepEqual(Object.keys(list.projects[0]).slice(-4), ["video_count", "dubbed_count", "pending_count", "videos"]);
  assert.deepEqual(await post("/api/projects/delete", { id: "so-tan-cau-ca-2" }), { ok: true });
  assert.equal((await app.inject({ url: "/api/projects" })).json().total, 1);
});
