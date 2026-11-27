/** Module resources: font, giọng đọc, mô hình nhận diện, xem trước phụ đề — trên thư mục tạm, Python giả. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

// Python giả: asr.py list/set-vad, voice_tool.py clone/preview (ghi file --out rồi in JSON như script thật).
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "reup-fakepy-"));
const fakePy = path.join(binDir, "fakepy");
fs.writeFileSync(
  fakePy,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [script, cmd, ...rest] = process.argv.slice(2);
const opt = (k) => rest[rest.indexOf(k) + 1];
const name = path.basename(script);
if (name === "asr.py" && cmd === "list") console.log(JSON.stringify({ models: [{ id: "m1", name: "M1", installed: true }] }));
else if (name === "asr.py" && cmd === "set-vad") process.exit(rest[0] === "silero" ? 0 : 1);
else if (name === "voice_tool.py" && opt("--src").includes("hong")) { console.log(JSON.stringify({ ok: false, error: "Nguồn không có giọng nói." })); process.exit(1); }
else if (name === "voice_tool.py") {
  fs.mkdirSync(path.dirname(opt("--out")), { recursive: true });
  fs.writeFileSync(opt("--out"), "x");
  console.log(JSON.stringify({ ok: true, gender: "male", f0: 120, start: 1, end: 9 }));
} else process.exit(2);
`,
  { mode: 0o755 }
);

// setupApp trước mọi import của server: config.mjs đọc biến môi trường lúc nạp.
const { app, dir, cleanup } = await setupApp({ REUP_PYTHON: fakePy });
after(async () => {
  await cleanup();
  fs.rmSync(binDir, { recursive: true, force: true });
});
const { MODULES } = await import("../app.mjs");
const { ROOT } = await import("../config.mjs");
const { createResourceService } = await import("../modules/resources/service.mjs");
const { resourceRepo } = await import("../modules/resources/repo.mjs");

const get = (url) => app.inject({ method: "GET", url });
const post = (url, payload) => app.inject({ method: "POST", url, payload });
const raw = (url, body) => app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/octet-stream" } });
const put = (rel, data = "x") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof data === "string" ? data : JSON.stringify(data));
};
const readJ = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));

test("module resources khai deps dub + project + sources; không còn routes/voices.mjs, routes/resources.mjs, lib/voices.mjs", () => {
  const m = MODULES.find((x) => x.name === "resources");
  assert.deepEqual(m.deps, ["dub", "project", "sources"]);
  assert.ok(!MODULES.some((x) => x.name === "voices"));
  for (const f of ["server/routes/voices.mjs", "server/routes/resources.mjs", "server/lib/voices.mjs"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), f);
  assert.ok(resourceRepo.FONTS_DIR.startsWith(dir + path.sep) && resourceRepo.VOICES_DIR.startsWith(dir + path.sep));
});

test("font: tải lên font thật vào data/fonts tạm, trùng -> 409, tải file, xóa", async (t) => {
  const ttf = ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((f) => fs.existsSync(f));
  if (!ttf) return t.skip("máy không có file .ttf mẫu");
  const buf = fs.readFileSync(ttf);
  const up = await raw(`/api/fonts/upload?name=${encodeURIComponent(path.basename(ttf))}`, buf);
  assert.equal(up.statusCode, 200, up.body);
  const font = up.json().font;
  assert.ok(fs.existsSync(path.join(dir, "fonts", font.file)));
  assert.equal(readJ("fonts.json")[0].id, font.id);
  const dup = await raw(`/api/fonts/upload?name=${encodeURIComponent(path.basename(ttf))}`, buf);
  assert.equal(dup.statusCode, 409);
  assert.deepEqual(fs.readdirSync(path.join(dir, "fonts")), [font.file]); // file tạm của lần trùng đã bị xóa
  const list = (await get("/api/fonts")).json();
  assert.equal(list.ok, true);
  assert.equal(list.fonts.length, 1);
  assert.ok(Array.isArray(list.system));
  const file = await get(`/api/fonts/file?id=${font.id}`);
  assert.equal(file.statusCode, 200);
  assert.equal(file.rawPayload.length, buf.length);
  assert.deepEqual((await post("/api/fonts/delete", { id: font.id })).json(), { ok: true });
  assert.ok(!fs.existsSync(path.join(dir, "fonts", font.file)));
  assert.deepEqual(readJ("fonts.json"), []);
});

test("lỗi ở biên: font/giọng/mô hình/xem trước sai -> 4xx {ok:false,error}", async () => {
  put("downloads/bilibili/v.mp4");
  const cases = [
    [raw("/api/fonts/upload?name=a.exe", Buffer.from("x")), 400],
    [raw("/api/fonts/upload?name=a.ttf", Buffer.from("khong phai font")), 400],
    [post("/api/fonts/delete", { id: "../x" }), 400],
    [post("/api/fonts/delete", { id: "khong-co" }), 404],
    [raw("/api/voices/upload?ext=exe", Buffer.from("x")), 400],
    [post("/api/voices/create", { rel_path: "downloads/bilibili/v.mp4" }), 400], // thiếu tên
    [post("/api/voices/create", { name: "A", rel_path: "downloads/khong-co.mp4" }), 400],
    [post("/api/voices/create", { name: "A", rel_path: "downloads/bilibili" }), 400], // thư mục, không phải file
    [post("/api/voices/create", { name: "A", upload: "../../etc/passwd" }), 400],
    [post("/api/voices/update", { slug: "khong-co" }), 404],
    [post("/api/voices/delete", { slug: "../x" }), 400],
    [get("/api/voices/preview?voice=xx&text=chao"), 400],
    [get("/api/voices/preview?voice=vieneu-clone:khong-co&text=chao"), 404],
    [post("/api/asr-models/vad", { id: "A B" }), 400],
    [post("/api/asr-models/vad", { id: "chua-tai" }), 400],
    [post("/api/asr-models/download", { id: "../x" }), 400],
    [post("/api/sub-preview", { rel_path: "downloads/khong-co.mp4" }), 400],
    [post("/api/sub-preview", { rel_path: "downloads/bilibili" }), 400],
    [post("/api/sub-preview", { rel_path: "downloads/bilibili/v.mp4", subcover: "rm -rf" }), 400],
    [post("/api/sub-preview", { rel_path: "downloads/bilibili/v.mp4", style: { color: "red" } }), 400],
  ];
  for (const [i, [p, code]] of cases.entries()) {
    const res = await p;
    assert.equal(res.statusCode, code, `case ${i}: ${res.body}`);
    assert.equal(res.json().ok, false, `case ${i}`);
    assert.ok(res.json().error, `case ${i}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, "fonts", "a.ttf")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "fonts")).filter((f) => f.startsWith(".upload-")), []);
});

test("mô hình nhận diện: danh sách + đặt VAD qua asr.py", async () => {
  assert.deepEqual((await get("/api/asr-models")).json(), { models: [{ id: "m1", name: "M1", installed: true }] });
  assert.deepEqual((await post("/api/asr-models/vad", { id: "silero" })).json(), { ok: true });
});

test("giọng: tải lên -> clone vào data/voices tạm + thêm vào dự án; đổi tên; xóa gỡ khỏi mọi dự án", async () => {
  put("projects/p1.json", { id: "p1", name: "P1", voices: ["vieneu:Adam"] });
  put("projects/p2.json", { id: "p2", name: "P2", voices: [] });
  const up = await raw("/api/voices/upload?ext=wav", Buffer.from("RIFF"));
  assert.equal(up.statusCode, 200, up.body);
  const { token } = up.json();
  assert.ok(fs.existsSync(path.join(dir, "voices", "_tmp", token)));

  const cr = await post("/api/voices/create", { name: "Giọng Thử", upload: token, upload_name: "a.wav", project_id: "p1" });
  assert.equal(cr.statusCode, 200, cr.body);
  const v = cr.json().voice;
  assert.equal(v.id, "vieneu-clone:giong-thu");
  assert.equal(v.gender, "male");
  assert.ok(fs.existsSync(path.join(dir, "voices", "giong-thu.wav")));
  assert.ok(!fs.existsSync(path.join(dir, "voices", "_tmp", token))); // file tải lên đã dọn
  assert.deepEqual(readJ("projects/p1.json").voices, ["vieneu:Adam", "vieneu-clone:giong-thu"]);

  // Clone thêm từ video nguồn, gắn vào p2; dự án không có thì bỏ qua, không tạo file.
  put("downloads/bilibili/v.mp4");
  const cr2 = await post("/api/voices/create", { name: "Giọng Thử", rel_path: "downloads/bilibili/v.mp4", project_id: "khong-co" });
  assert.equal(cr2.json().voice.slug, "giong-thu-2");
  assert.equal(cr2.json().voice.source, "Video: v.mp4");
  assert.ok(!fs.existsSync(path.join(dir, "projects", "khong-co.json")));
  const fail = await post("/api/voices/create", { name: "Hỏng", url: "https://x/hong.mp3" });
  assert.equal(fail.statusCode, 400);
  assert.deepEqual(fail.json(), { ok: false, error: "Nguồn không có giọng nói." });

  const list = (await get("/api/voices")).json();
  assert.equal(list.presets.length, 25);
  assert.deepEqual(list.clones.map((c) => c.id).sort(), ["vieneu-clone:giong-thu", "vieneu-clone:giong-thu-2"]);

  assert.deepEqual((await post("/api/voices/update", { slug: "giong-thu", name: "Mới", gender: "female" })).json(), { ok: true });
  assert.deepEqual(readJ("voices.json").find((x) => x.slug === "giong-thu").name, "Mới");
  const sample = await get("/api/voices/sample?slug=giong-thu");
  assert.equal(sample.statusCode, 200);

  assert.deepEqual((await post("/api/voices/delete", { slug: "giong-thu" })).json(), { ok: true });
  assert.ok(!fs.existsSync(path.join(dir, "voices", "giong-thu.wav")));
  assert.deepEqual(readJ("projects/p1.json").voices, ["vieneu:Adam"]);
  assert.deepEqual(readJ("voices.json").map((x) => x.slug), ["giong-thu-2"]);
});

test("nghe thử: voice_tool.py ghi file vào data/voices/_preview tạm, lần sau dùng lại", async () => {
  const r1 = await get(`/api/voices/preview?voice=${encodeURIComponent("vieneu:Adam")}&text=${encodeURIComponent("xin chào")}`);
  assert.equal(r1.statusCode, 200, r1.body);
  const files = fs.readdirSync(path.join(dir, "voices", "_preview"));
  assert.equal(files.length, 1);
  const r2 = await get(`/api/voices/preview?voice=${encodeURIComponent("vieneu:Adam")}&text=${encodeURIComponent("xin chào")}`);
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(fs.readdirSync(path.join(dir, "voices", "_preview")), files);
});

test("đang lồng tiếng: xóa font / giọng -> 409, không xóa gì", async () => {
  const calls = [];
  const svc = createResourceService(resourceRepo, {
    dub: { busyError: () => "Đang lồng tiếng." },
    project: { dropVoice: (id) => calls.push(id) },
    sources: { fileOf: () => "" },
    tasks: {},
  });
  put("voices/giu.wav");
  assert.throws(() => svc.removeVoice("giu"), (e) => e.statusCode === 409);
  assert.throws(() => svc.removeFont("abc"), (e) => e.statusCode === 409);
  assert.ok(fs.existsSync(path.join(dir, "voices", "giu.wav")));
  assert.deepEqual(calls, []);
});

test("/api/functions: hàm của resources gọi đúng route qua registry", async () => {
  const r = (await post("/api/functions/call", { name: "delete_font", arguments: { id: "khong-co" } })).json();
  assert.equal(r.status, "error");
  assert.match(r.error, /Không tìm thấy font/);
  const opts = (await post("/api/functions/call", { name: "list_options", arguments: {} })).json();
  assert.equal(opts.status, "done", JSON.stringify(opts));
  assert.equal(opts.result.asr_models[0].id, "m1");
  assert.ok(opts.result.voices.some((v) => v.id === "vieneu-clone:giong-thu-2"));
});
