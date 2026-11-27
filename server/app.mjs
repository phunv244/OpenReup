/**
 * Dựng app Fastify (chưa listen): server/index.mjs chạy thật, test gọi qua app.inject.
 * Server ghép từ các module (server/core/loader.mjs): thêm chức năng = thêm 1 module vào MODULES.
 * Module đã tách: server/modules/<tên>/ (index, routes, service, repo, functions). Các module còn lại bọc file route cũ
 * ở server/routes/ (đường dẫn API giữ nguyên) và sẽ chuyển dần sang server/modules/.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { API_TOKEN, DOWNLOADS_DIR, WEB_OUT_DIR } from "./config.mjs";
import { loadModules } from "./core/loader.mjs";
import { runMigrations } from "./lib/migrate.mjs";
import taskRoutes from "./routes/tasks.mjs";
import functionRoutes, { FUNCTIONS } from "./routes/functions.mjs";
import dubModule from "./modules/dub/index.mjs";
import projectModule from "./modules/project/index.mjs";
import sourcesModule from "./modules/sources/index.mjs";
import resourcesModule from "./modules/resources/index.mjs";
import aiModule from "./modules/ai/index.mjs";

/** Danh sách module của server. Thứ tự nạp do loader sắp theo deps. */
export const MODULES = [
  { name: "tasks", routes: taskRoutes },
  sourcesModule,
  projectModule,
  resourcesModule,
  dubModule,
  aiModule,
  // Tạm giữ toàn bộ định nghĩa hàm ở đây; mỗi module chuyển sang server/modules/ sẽ mang hàm của nó theo.
  { name: "functions", functions: FUNCTIONS.filter((f) => !f.slot && !f.ref), routes: (app, ctx) => functionRoutes(app, ctx.functions()) },
];

export async function buildApp({ logger = false } = {}) {
  runMigrations();

  const app = Fastify({ bodyLimit: 8_000_000, logger });

  // Có REUP_API_TOKEN: mọi request ghi (không phải GET/HEAD) vào /api/ phải kèm Bearer token.
  if (API_TOKEN) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.method === "GET" || req.method === "HEAD" || !req.url.startsWith("/api/")) return;
      if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return reply.code(401).send({ ok: false, error: "Thiếu hoặc sai token (Authorization: Bearer)." });
    });
  }

  // Chặn CSRF: trang web lạ không được gọi POST vào server local.
  // DEV_WEB_ORIGIN=localhost:3000 khi chạy giao diện Next ở chế độ dev (npm run dev:web).
  const DEV_ORIGINS = String(process.env.DEV_WEB_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (req.method !== "POST" || !origin) return;
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== req.headers.host && !DEV_ORIGINS.includes(host)) return reply.code(403).send({ ok: false, error: "Origin không hợp lệ" });
  });

  // API không cache; lỗi luôn trả {ok:false, error} như giao diện đang đọc.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/") && !reply.getHeader("cache-control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const code = err.statusCode >= 400 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ ok: false, error: err.message });
  });

  // Giao diện (Next.js, bản build tĩnh trong web/out) ở "/". Bản đăng ký đầu tiên tạo reply.sendFile dùng cho các route khác.
  if (!fs.existsSync(WEB_OUT_DIR)) {
    console.warn("[Giao diện] Chưa có web/out — chạy: npm --prefix web install && npm run build:web");
    fs.mkdirSync(WEB_OUT_DIR, { recursive: true });
  }
  await app.register(fastifyStatic, {
    root: WEB_OUT_DIR,
    prefix: "/",
    // HTML luôn hỏi lại (bản build mới có hiệu lực ngay); file JS/CSS của Next có mã băm trong tên nên giữ lâu được.
    cacheControl: false,
    setHeaders: (reply, file) =>
      reply.header("Cache-Control", file.includes(`${path.sep}_next${path.sep}static${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
  });
  // Video tải về / bản lồng tiếng (hỗ trợ tua: Range request).
  await app.register(fastifyStatic, {
    root: DOWNLOADS_DIR,
    prefix: "/downloads/",
    decorateReply: false,
    setHeaders: (reply, file) => file.endsWith(".srt") && reply.header("Content-Type", "text/plain; charset=utf-8"),
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/downloads/")) {
      return reply.code(404).send({ ok: false, error: "Không tìm thấy" });
    }
    return fs.existsSync(path.join(WEB_OUT_DIR, "404.html")) ? reply.code(404).sendFile("404.html") : reply.code(404).send("Not found");
  });

  await loadModules(app, MODULES);

  return app;
}
