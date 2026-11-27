/** HTTP của module sources: chỉ đọc request, gọi service, trả JSON (đường dẫn API giữ như cũ). */
import fs from "node:fs";
import { ensureThumb, extractFrame } from "../../lib/media.mjs";

// Tác vụ nền: bận (đã có tác vụ chạy / hàng đợi đầy) trả 409 kèm {ok:false, error}.
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function sourceRoutes(app, ctx, sources) {
  /* ---------- Douyin ---------- */
  app.get("/api/videos", async () => sources.douyinVideos());
  app.post("/api/login", async (req, reply) => send(reply, sources.login(req.body?.url)));
  app.post("/api/scan", async (req, reply) => send(reply, sources.scan(req.body || {})));
  app.post("/api/download", async (req, reply) => send(reply, sources.downloadDouyin(req.body || {})));
  app.post("/api/status", async (req) => sources.setDouyinStatus(req.body?.key, req.body?.status));

  /* ---------- Bilibili / YouTube ---------- */
  app.get("/api/bilibili", async () => sources.listBilibili());
  app.post("/api/bilibili/download", async (req, reply) => send(reply, sources.downloadBilibili(req.body || {})));
  app.post("/api/bilibili/delogo", async (req, reply) => send(reply, sources.delogo(req.body || {})));

  /* ---------- Video nguồn ---------- */
  app.get("/api/sources", async () => sources.list());

  app.get("/api/thumb", async (req, reply) => {
    const full = sources.fileOf(req.query.rel);
    const thumb = full ? await ensureThumb(full, fs.statSync(full)) : "";
    if (!thumb) return reply.code(404).send("Not found");
    return reply.type("image/jpeg").header("Cache-Control", "max-age=604800").send(fs.createReadStream(thumb));
  });

  app.get("/api/frame", async (req, reply) => {
    const full = sources.fileOf(req.query.rel);
    if (!full) return reply.code(404).send("Not found");
    const img = await extractFrame(full);
    if (!img) return reply.code(500).send("Không trích được khung hình");
    return reply.type("image/jpeg").header("Cache-Control", "no-store").send(img);
  });

  app.post("/api/source/assign", async (req) => sources.assign(req.body?.rel_path, req.body?.project_id));
  app.post("/api/source/delete", async (req) => sources.remove(req.body || {}));
}
