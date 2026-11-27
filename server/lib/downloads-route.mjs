/**
 * GET/HEAD /downloads/* : video tải về và bản lồng tiếng, cả bố cục cũ (downloads/...) lẫn mới (data/videos/...).
 * Mỗi request tra rel_path qua lookupDownload (chặn ../, symlink ra ngoài), rồi gửi file bằng @fastify/send với cùng
 * tùy chọn mặc định như @fastify/static trước đây, nên header giữ nguyên: Content-Type (.srt là text/plain; charset=utf-8),
 * Accept-Ranges, Range → 206 + Content-Range, Range sai → 416, Cache-Control/ETag/Last-Modified, không có → 404.
 */
import path from "node:path";
import send from "@fastify/send";
import { lookupDownload } from "./videos.mjs";

send.mime.default_type = "application/octet-stream"; // như @fastify/static

export default async function downloadsRoute(app) {
  app.route({
    method: ["GET", "HEAD"],
    url: "/downloads/*",
    schema: { hide: true },
    handler: async (req, reply) => {
      const hit = lookupDownload(`downloads/${req.params["*"]}`);
      if (!hit) return reply.callNotFound();
      const { statusCode, headers, stream, type, metadata } = await send(req.raw, encodeURIComponent(path.basename(hit.abs)), {
        root: path.dirname(hit.abs),
        dotfiles: "allow",
      });
      if (type === "file") {
        reply.code(statusCode).headers(headers);
        if (hit.abs.endsWith(".srt")) reply.header("Content-Type", "text/plain; charset=utf-8");
        return reply.send(stream);
      }
      // Thư mục, file không có: 404 như route khác. Lỗi còn lại (Range không hợp lệ → 416...) gửi nguyên lỗi của send.
      if (type === "directory" || metadata.error?.code === "ENOENT" || metadata.error?.status === 404) return reply.callNotFound();
      return reply.send(metadata.error);
    },
  });
}
