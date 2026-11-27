/** Module dub: project lấy số liệu qua ctx.get("dub"), đọc meta theo work_dir, chặn xóa dự án đang lồng tiếng, luôn truyền đường dẫn cho dub_video.py. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { seedJob, setupApp } from "./helpers.mjs";

// Python giả: ghi lại tham số dòng lệnh rồi ngủ FAKE_SLEEP giây (để có 1 tác vụ lồng tiếng "đang chạy").
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "reup-fakepy-"));
const fakePy = path.join(binDir, "fakepy");
const argsFile = path.join(binDir, "args.txt");
fs.writeFileSync(fakePy, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexec sleep "\${FAKE_SLEEP:-0}"\n`, { mode: 0o755 });

// setupApp trước mọi import của server: config.mjs đọc REUP_DATA_DIR lúc nạp.
const { app, db, dir, cleanup } = await setupApp({ REUP_PYTHON: fakePy });
after(async () => {
  await cleanup();
  fs.rmSync(binDir, { recursive: true, force: true });
});
const { loadModules } = await import("../core/loader.mjs");
const { MODULES } = await import("../app.mjs");
const { createProjectService } = await import("../modules/project/service.mjs");
const { createDubService } = await import("../modules/dub/service.mjs");
const { stopTask, taskEvents } = await import("../lib/tasks.mjs");

const post = (url, payload) => app.inject({ method: "POST", url, payload });
const writeJson = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
};
const B = "downloads/bilibili/";

test("project khai deps dub và lấy số liệu qua ctx.get(\"dub\"): vẫn 3/2/1 và 3/3/0", async () => {
  const projectModule = MODULES.find((m) => m.name === "project");
  assert.deepEqual(projectModule.deps, ["dub"]);
  // Dữ liệu giống data/ thật 2026-11-27 (xem project-module.test.mjs), đưa vào qua 1 module dub giả.
  const owners = {
    [`${B}BVtest1.mp4`]: "so-tan-cau-ca", [`${B}BVtest2.mp4`]: "so-tan-cau-ca", [`${B}BV1nHW.mp4`]: "so-tan-cau-ca",
    [`${B}4796.mp4`]: "cau-ca-van-can", [`${B}4795.mp4`]: "cau-ca-van-can",
  };
  const dubbed = [
    ["t1a", "so-tan-cau-ca", "BVtest1"], ["t1b", "so-tan-cau-ca", "BVtest1"], ["t2", "so-tan-cau-ca", "BVtest2"],
    ["c1", "cau-ca-van-can", "4795"], ["c2", "cau-ca-van-can", "BV1wyx"], ["c3", "cau-ca-van-can", "4796"],
  ];
  const fakeDub = {
    name: "dub",
    init: () => ({
      list: () => dubbed.map(([job_id, project_id]) => ({ job_id, project_id })),
      sources: () => new Map(dubbed.map(([job, , src]) => [job, `${B}${src}.mp4`])),
    }),
  };
  const fakeRepo = { owners: () => owners, sourceExists: () => true };
  const project = { ...projectModule, routes: undefined, init: (ctx) => createProjectService(fakeRepo, ctx.get("dub")) };
  const { services } = await loadModules({ register: async () => {} }, [project, fakeDub]);
  const counts = (id) => ["video_count", "dubbed_count", "pending_count"].map((k) => services.get("project").stats(id)[k]);
  assert.deepEqual(counts("so-tan-cau-ca"), [3, 2, 1]);
  assert.deepEqual(counts("cau-ca-van-can"), [3, 3, 0]);
});

test("GET /api/projects đọc meta.json theo work_dir lưu trong dubbed.json (thư mục job đã chuyển chỗ)", async () => {
  const src = path.resolve(dir, "..", "nguon.mp4");
  writeJson("dub_work/job_a/meta.json", { job_id: "job_a", input_path: src });
  writeJson("doi_ten/job_b/meta.json", { job_id: "job_b", input_path: src }); // không nằm trong data/dub_work/
  writeJson("dubbed.json", {
    videos: [
      { job_id: "job_a", project_id: "wd" },
      { job_id: "job_b", project_id: "wd", work_dir: path.join(dir, "doi_ten", "job_b") },
      { job_id: "job_c", project_id: "wd" }, // mất meta: tự là 1 video
    ],
  });
  await post("/api/projects", { name: "wd" });
  const p = (await app.inject({ url: "/api/projects" })).json().projects.find((x) => x.id === "wd");
  // job_a + job_b cùng 1 nguồn = 1 video; job_c = 1 video.
  assert.deepEqual([p.video_count, p.dubbed_count, p.pending_count], [2, 2, 0]);
});

/** Xuất lại 1 job (Python giả), trả tham số dòng lệnh khi tiến trình đã khởi chạy. */
async function startRerender(jobId) {
  fs.rmSync(argsFile, { force: true });
  const res = await post("/api/dub/rerender", { job_id: jobId });
  assert.equal(res.statusCode, 200, res.body);
  for (let i = 0; i < 100 && !fs.existsSync(argsFile); i++) await new Promise((r) => setTimeout(r, 20));
  return fs.readFileSync(argsFile, "utf8").trim().split("\n");
}
const argOf = (args, k) => args[args.indexOf(k) + 1];

test("chặn xóa dự án khi đang lồng tiếng video của dự án đó; dừng xong thì xóa được", async () => {
  const { project } = (await post("/api/projects", { name: "Dang ban" })).json();
  seedJob(db, dir, "job_busy", [[0, 1]]);
  writeJson("dub_projects/job_busy.json", { job_id: "job_busy", voice: "test", speakers: {}, project_id: project.id });
  process.env.FAKE_SLEEP = "30";
  await startRerender("job_busy");
  const res = await post("/api/projects/delete", { id: project.id });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().ok, false);
  assert.match(res.json().error, /đang có video lồng tiếng/);
  assert.ok(fs.existsSync(path.join(dir, "projects", `${project.id}.json`)), "file dự án vẫn còn");
  // Dự án khác không bị chặn.
  const other = (await post("/api/projects", { name: "Khong ban" })).json().project;
  assert.deepEqual((await post("/api/projects/delete", { id: other.id })).json(), { ok: true });

  const ended = new Promise((r) => taskEvents.once("end", r));
  stopTask();
  await ended;
  process.env.FAKE_SLEEP = "0";
  assert.deepEqual((await post("/api/projects/delete", { id: project.id })).json(), { ok: true });
});

test("isProjectBusy tính cả tác vụ đang chờ trong hàng đợi (dub_video theo --story-project)", () => {
  const svc = createDubService({
    dubTasks: () => [{ type: "dub_video", target: "x.mp4", args: ["-u", "dub_video.py", "--story-project", "p1"] }],
    loadDubProject: () => null,
  });
  assert.equal(svc.isProjectBusy("p1"), true);
  assert.equal(svc.isProjectBusy("p2"), false);
  assert.equal(svc.isProjectBusy(""), false);
});

test("luôn truyền đường dẫn cho dub_video.py: mặc định theo DATA_DIR, có work_dir/out_dir đã lưu thì dùng lại", async () => {
  seedJob(db, dir, "job_paths", [[0, 1]]);
  const ended = () => new Promise((r) => taskEvents.once("end", r));
  let done = ended();
  let args = await startRerender("job_paths");
  await done;
  assert.equal(argOf(args, "--work-dir"), path.join(dir, "dub_work", "job_paths"));
  assert.equal(argOf(args, "--project-file"), path.join(dir, "dub_projects", "job_paths.json"));
  assert.equal(argOf(args, "--index-file"), path.join(dir, "dubbed.json"));
  assert.equal(argOf(args, "--story-dir"), path.join(dir, "projects"));
  assert.ok(argOf(args, "--out-dir").endsWith(path.join("downloads", "dubbed")));

  // Lần chạy trước Python đã lưu work_dir/out_dir khác (tương đối với thư mục repo): lần sau phải truyền lại đúng chỗ đó.
  const saved = path.join(dir, "video_x", "work");
  writeJson("dub_projects/job_paths.json", { job_id: "job_paths", voice: "test", speakers: {}, work_dir: saved, out_dir: path.join(dir, "video_x") });
  done = ended();
  args = await startRerender("job_paths");
  await done;
  assert.equal(argOf(args, "--work-dir"), saved);
  assert.equal(argOf(args, "--out-dir"), path.join(dir, "video_x"));
});

test("jobIdFor khớp job_id dub_video.py đã tạo cho các video thật", () => {
  const { jobIdFor } = createDubService({});
  for (const [name, speed, want] of [
    ["BVtest1_p1_cau_ca_ngan.mp4", 0.65, "dub_BVtest1_p1_cau_ca_ngan_0p65x"],
    ["4795815441340424_p1_T_p_319_-_Than_ph_n_th_t_s_c_a_ng_i_an_ong_i_m_tre.mp4", 0.65, "dub_4795815441340424_p1_T_p_319_-_Th_3cb268_0p65x"],
    ["BV1nHW3z3EhH_p1__.mp4", 0.5, "dub_BV1nHW3z3EhH_p1_bc7260_0p5x"],
    ["BV1wyxS62Etu_p1_sec_000000-000800_1-398.mp4", 0.65, "dub_BV1wyxS62Etu_p1_sec_000000-00080_423aa4_0p65x"],
  ]) assert.equal(jobIdFor(`/x/${name}`, speed), want);
  assert.equal(jobIdFor("/x/a.mp4", 1), "dub_a_1p0x");
});
