/**
 * /api/functions phải giữ nguyên trong lúc chia module: MausBot và mcp-server.mjs đọc tên hàm + tham số từ đây.
 * Cố ý đổi API thì chạy: UPDATE_SNAPSHOT=1 npm run test:api, rồi báo FE/MausBot.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const SNAP = path.join(import.meta.dirname, "snapshots", "functions.json");
const { app, cleanup } = await setupApp();
after(cleanup);

test("GET /api/functions khớp snapshot (tên, mô tả, tham số, required)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/functions" });
  assert.equal(res.statusCode, 200);
  const got = res.json().functions;
  if (process.env.UPDATE_SNAPSHOT === "1") fs.writeFileSync(SNAP, JSON.stringify(got, null, 2) + "\n");
  const want = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  assert.deepEqual(got.map((f) => f.function.name), want.map((f) => f.function.name), "Danh sách / thứ tự tên hàm đã đổi");
  assert.deepEqual(got, want);
});

test("POST /api/functions/call gọi được hàm qua registry của loader", async () => {
  const res = await app.inject({ method: "POST", url: "/api/functions/call", payload: { name: "list_calls", arguments: {} } });
  assert.equal(res.json().status, "done", res.body);
  const bad = await app.inject({ method: "POST", url: "/api/functions/call", payload: { name: "khong_co" } });
  assert.match(bad.json().error, /Không có hàm "khong_co"\. Các hàm: download_video/);
});

test("routes/functions.mjs chỉ còn chỗ giữ; chỗ giữ của module chưa nạp bị bỏ qua và báo lúc khởi động", async () => {
  const Fastify = (await import("fastify")).default;
  const { DUB_FUNCTIONS } = await import("../modules/dub/functions.mjs");
  const { RESOURCE_FUNCTIONS } = await import("../modules/resources/functions.mjs");
  const { default: functionRoutes, FUNCTIONS } = await import("../routes/functions.mjs");
  assert.equal(DUB_FUNCTIONS.length, 11);
  assert.ok(FUNCTIONS.every((f) => (f.slot || f.ref) && !f.name), "FUNCTIONS chỉ chứa { slot } / { ref }, định nghĩa hàm nằm ở module");
  // Registry chỉ có hàm của resources (các module khác chưa nạp): /api/functions vẫn trả các hàm này.
  const own = RESOURCE_FUNCTIONS.map((f) => ({ ...f, module: "resources" }));
  const lone = Fastify();
  const warned = [];
  const warn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    await functionRoutes(lone, own, () => {});
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /"dub_video"/);
  assert.match(warned[0], /slot "tasks"/);
  const res = await lone.inject({ method: "GET", url: "/api/functions" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().functions.map((f) => f.function.name), own.map((f) => f.name));
  await lone.close();
});

test("đóng app gỡ hết bộ nghe taskEvents (sources, dub editor, resources, /api/functions)", async () => {
  // App thứ 2 trên cùng thư mục tạm của setupApp (config đã trỏ REUP_DATA_DIR tạm): không chạm data/ thật.
  const { taskEvents } = await import("../lib/tasks.mjs");
  const { buildApp } = await import("../app.mjs");
  const count = () => ["start", "end", "saved_file"].map((e) => taskEvents.listenerCount(e));
  const before = count();
  const second = await buildApp();
  await second.ready();
  assert.deepEqual(count(), [before[0] + 1, before[1] + 3, before[2] + 1]);
  await second.close();
  assert.deepEqual(count(), before);
});
