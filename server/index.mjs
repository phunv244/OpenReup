/**
 * OpenReup Studio — máy chủ web cục bộ (Fastify).
 * Phục vụ giao diện, API, hàng đợi tiến trình nền (quét / tải / xóa logo / lồng tiếng) và file video.
 * Mỗi nhóm API nằm trong một file ở server/routes/.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { DOWNLOADS_DIR, HOST, PORT, WEB_OUT_DIR } from "./config.mjs";
import { runMigrations } from "./lib/migrate.mjs";
import { shutdownTasks } from "./lib/tasks.mjs";
import { clearVoiceTmp } from "./lib/voices.mjs";
import dubRoutes from "./routes/dub.mjs";
import projectRoutes from "./routes/projects.mjs";
import sourceRoutes from "./routes/sources.mjs";
import taskRoutes from "./routes/tasks.mjs";
import resourceRoutes from "./routes/resources.mjs";
import voiceRoutes from "./routes/voices.mjs";
import agyProxyRoutes from "./routes/agyProxy.mjs";
import agyCliChatRoutes from "./routes/agyCliChat.mjs";

runMigrations();
clearVoiceTmp();

const app = Fastify({ bodyLimit: 8_000_000 });

// Chặn CSRF: trang web lạ không được gọi POST vào server local.
// DEV_WEB_ORIGIN=localhost:3000 khi chạy giao diện Next ở chế độ dev (npm run dev:web).
const DEV_ORIGINS = String(process.env.DEV_WEB_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.addHook("onRequest", async (req, reply) => {
  if (req.url.startsWith("/v1/")) return; // OpenAI-compatible gateway có CORS & API key riêng
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

await app.register(taskRoutes);
await app.register(sourceRoutes);
await app.register(projectRoutes);
await app.register(voiceRoutes);
await app.register(resourceRoutes);
await app.register(dubRoutes);
await app.register(agyProxyRoutes);
await app.register(agyCliChatRoutes);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shutdownTasks();
    process.exit(0);
  });
}

// Chỉ localhost: API không có xác thực, có thao tác xoá file. Đặt HOST=0.0.0.0 nếu thật sự cần mở LAN.
await app.listen({ port: PORT, host: HOST });
console.log(`OpenReup Studio đang chạy tại: http://localhost:${PORT}`);
