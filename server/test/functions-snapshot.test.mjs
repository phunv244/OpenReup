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

test("hàm lồng tiếng do module dub khai; chỗ giữ của hàm không có trong registry bị bỏ qua", async () => {
  const Fastify = (await import("fastify")).default;
  const { DUB_FUNCTIONS } = await import("../modules/dub/functions.mjs");
  const { default: functionRoutes, FUNCTIONS } = await import("../routes/functions.mjs");
  assert.equal(DUB_FUNCTIONS.length, 11);
  assert.ok(FUNCTIONS.some((f) => f.ref === "dub_video") && !FUNCTIONS.some((f) => f.name === "dub_video"));
  // Registry thiếu toàn bộ hàm của module dub (module chưa nạp): /api/functions vẫn trả các hàm còn lại.
  const own = FUNCTIONS.filter((f) => f.name);
  const lone = Fastify();
  const warned = [];
  const warn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    await functionRoutes(lone, own);
  } finally {
    console.warn = warn;
  }
  // Chỗ giữ không có hàm (vd gõ sai tên trong { ref }) được báo lúc khởi động, không im lặng.
  assert.equal(warned.length, 1);
  assert.match(warned[0], /"dub_video"/);
  const res = await lone.inject({ method: "GET", url: "/api/functions" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().functions.map((f) => f.function.name), own.map((f) => f.name));
  await lone.close();
});
