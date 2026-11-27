/** core/loader.mjs: thứ tự nạp theo deps, báo lỗi khai sai ngay lúc khởi động, ctx.get chỉ cho deps đã khai. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { loadModules, orderModules } from "../core/loader.mjs";

const names = (mods) => orderModules(mods).map((m) => m.name);

test("sắp theo deps, giữ thứ tự khai báo khi không ràng buộc", () => {
  assert.deepEqual(names([{ name: "dub", deps: ["project", "core"] }, { name: "project", deps: ["core"] }, { name: "core" }, { name: "ai" }]), ["core", "project", "dub", "ai"]);
});

test("thiếu phụ thuộc / phụ thuộc vòng / trùng tên / tên sai -> lỗi", () => {
  assert.throws(() => orderModules([{ name: "dub", deps: ["project"] }]), /"dub" cần "project"/);
  assert.throws(() => orderModules([{ name: "a", deps: ["b"] }, { name: "b", deps: ["c"] }, { name: "c", deps: ["a"] }]), /vòng.*a -> b -> c -> a/);
  assert.throws(() => orderModules([{ name: "a" }, { name: "a" }]), /Trùng tên module "a"/);
  assert.throws(() => orderModules([{ name: "Bad Name" }]), /không hợp lệ/);
});

test("init nhận service của deps; route đăng ký được; ctx.get ngoài deps -> lỗi", async () => {
  const app = Fastify();
  const seen = [];
  const { services } = await loadModules(app, [
    {
      name: "dub",
      deps: ["project"],
      init: (ctx) => {
        seen.push(ctx.get("project").stats("p1"));
        assert.throws(() => ctx.get("ai"), /chưa khai "ai" trong deps/);
        return {};
      },
      routes: (a, ctx) => a.get("/x", async () => ({ n: ctx.get("project").stats("p2") })),
    },
    { name: "project", init: () => ({ stats: (id) => `stats:${id}` }) },
    { name: "ai", init: () => ({}) },
  ]);
  assert.deepEqual(seen, ["stats:p1"]);
  assert.ok(services.has("ai"));
  assert.deepEqual((await app.inject({ url: "/x" })).json(), { n: "stats:p2" });
  await app.close();
});

test("gom functions của mọi module theo thứ tự nạp; trùng tên hàm -> lỗi", async () => {
  const { functions } = await loadModules(Fastify(), [
    { name: "b", deps: ["a"], functions: [{ name: "f2" }] },
    { name: "a", functions: [{ name: "f1" }] },
  ]);
  assert.deepEqual(functions.map((f) => f.name), ["f1", "f2"]);
  await assert.rejects(loadModules(Fastify(), [{ name: "a", functions: [{ name: "f" }] }, { name: "b", functions: [{ name: "f" }] }]), /Hàm "f" khai ở cả module "a" và "b"/);
});
