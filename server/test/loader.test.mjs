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

test("ctx.get báo lỗi ngay khi module phụ thuộc không có service", async () => {
  await assert.rejects(
    loadModules(Fastify(), [{ name: "a", routes: () => {} }, { name: "b", deps: ["a"], init: (ctx) => ctx.get("a") }]),
    /Module "b" gọi ctx.get\("a"\) nhưng "a" không có service/
  );
});

test("ctx.functions() đóng băng: module không sửa được danh sách hàm chung", async () => {
  let got;
  await loadModules(Fastify(), [{ name: "a", functions: [{ name: "f1" }], init: (ctx) => ((got = ctx.functions()), {}) }]);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got[0]));
  assert.throws(() => got.push({ name: "x" }), TypeError);
  assert.throws(() => { got[0].name = "x"; }, TypeError);
});

test("routes nhận service của chính module; mỗi hàm kèm tên module khai nó", async () => {
  const app = Fastify();
  const { functions } = await loadModules(app, [{ name: "p", init: () => ({ hi: () => "chào" }), routes: (a, ctx, svc) => a.get("/p", async () => svc.hi()), functions: [{ name: "f" }] }]);
  assert.equal((await app.inject({ url: "/p" })).body, "chào");
  assert.equal(functions[0].module, "p");
  await app.close();
});

test("MODULES của server: thiếu module ai (list_options của resources đọc /api/agy-models) -> lỗi lúc khởi động", async () => {
  const { MODULES } = await import("../app.mjs");
  assert.ok(MODULES.find((m) => m.name === "resources").deps.includes("ai"));
  // Module dub cũng cần ai: gỡ deps "ai" của module khác để chắc lỗi đến từ khai báo của "resources".
  const noAi = MODULES.filter((m) => m.name !== "ai").map((m) => (m.name === "resources" ? m : { ...m, deps: (m.deps || []).filter((d) => d !== "ai") }));
  assert.throws(() => orderModules(noAi), /"resources" cần "ai"/);
});

test("MODULES của server: module \"functions\" không khai hàm riêng; get_task/stop_task/get_call/list_calls thuộc module tasks", async () => {
  const { MODULES } = await import("../app.mjs");
  assert.equal(MODULES.find((m) => m.name === "functions").functions, undefined);
  assert.deepEqual(MODULES.find((m) => m.name === "tasks").functions.map((f) => f.name), ["get_task", "stop_task", "get_call", "list_calls"]);
});
