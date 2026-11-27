/** Module ai: model dịch của Antigravity (cache, làm mới, lỗi lệnh agy) và việc module dub kiểm tra agy_model qua ctx.get("ai"). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

// agy giả: `agy models` in nội dung file OUT (đổi file để giả Antigravity thêm/bớt model).
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "reup-fakeagy-"));
const OUT = path.join(binDir, "models.txt");
const fakeAgy = path.join(binDir, "agy");
fs.writeFileSync(fakeAgy, `#!${process.execPath}\nif (process.argv[2] !== "models") process.exit(2);\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(OUT)}, "utf8"));\n`, { mode: 0o755 });
fs.writeFileSync(OUT, "Fetching models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)\nclaude-x\tClaude X\n");

const { app, dir, cleanup } = await setupApp({ AGY_BIN: fakeAgy });
after(async () => {
  await cleanup();
  fs.rmSync(binDir, { recursive: true, force: true });
});
const CACHE = path.join(dir, "agy_models.json");
const get = (url) => app.inject({ method: "GET", url });
const post = (url, payload = {}) => app.inject({ method: "POST", url, payload });

test("parseAgyModels bỏ dòng lạ, groupAgyModels gom theo mức suy nghĩ (low trước high)", async () => {
  const { parseAgyModels, groupAgyModels } = await import("../modules/ai/service.mjs");
  const models = parseAgyModels(fs.readFileSync(OUT, "utf8") + "Bad Id\tx\n");
  assert.deepEqual(models.map((m) => m.id), ["gemini-4-neon-high", "gemini-4-neon-low", "claude-x"]);
  assert.deepEqual(groupAgyModels(models), [
    { base: "gemini-4-neon", name: "Gemini 4 Neon", efforts: [{ effort: "low", id: "gemini-4-neon-low" }, { effort: "high", id: "gemini-4-neon-high" }] },
    { base: "claude-x", name: "Claude X", efforts: [{ effort: "", id: "claude-x" }] },
  ]);
});

test("GET /api/agy-models: chưa có cache thì hỏi agy và ghi cache vào REUP_DATA_DIR; có cache thì không hỏi lại", async () => {
  const res = (await get("/api/agy-models")).json();
  assert.equal(res.ok, true);
  assert.equal(res.models.length, 3);
  assert.equal(res.groups.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(CACHE, "utf8")).models.length, 3);
  fs.writeFileSync(OUT, "other\tOther\n");
  assert.equal((await get("/api/agy-models")).json().models.length, 3, "phải đọc từ cache");
});

test("POST /api/agy-models/refresh báo model mới và model bị xóa", async () => {
  fs.writeFileSync(OUT, "gemini-4-neon-high\tGemini 4 Neon (High)\nnew-model\tNew Model\n");
  const res = (await post("/api/agy-models/refresh")).json();
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, ["New Model"]);
  assert.deepEqual(res.removed, ["Gemini 4 Neon (Low)", "Claude X"]);
});

test("làm mới lỗi (agy không trả model / không có lệnh agy): ok:false, giữ nguyên cache", async () => {
  fs.writeFileSync(OUT, "Fetching models...\n");
  const empty = (await post("/api/agy-models/refresh")).json();
  assert.equal(empty.ok, false);
  assert.match(empty.error, /không trả về model nào/);
  assert.equal(empty.models.length, 2);

  process.env.AGY_BIN = path.join(binDir, "khong-co-agy");
  try {
    const res = await post("/api/agy-models/refresh");
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.match(res.json().error, /Không tìm thấy lệnh agy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(CACHE, "utf8")).models.map((m) => m.id), ["gemini-4-neon-high", "new-model"]);
  } finally {
    process.env.AGY_BIN = fakeAgy;
  }
});

test("POST /api/dub/start từ chối agy_model sai dạng (kiểm qua service của module ai)", async () => {
  fs.mkdirSync(path.join(dir, "downloads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "downloads", "v.mp4"), "x");
  const res = await post("/api/dub/start", { rel_path: "downloads/v.mp4", agy_model: "Bad Model!" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "Model dịch không hợp lệ.");
});

test("module dub khai phụ thuộc ai: bỏ module ai khỏi danh sách thì báo lỗi lúc khởi động", async () => {
  const { MODULES } = await import("../app.mjs");
  const { orderModules } = await import("../core/loader.mjs");
  assert.throws(() => orderModules(MODULES.filter((m) => m.name !== "ai")), /Module "dub" cần "ai"/);
});
