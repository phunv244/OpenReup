/** HTTP của module resources: chỉ đọc request, gọi service, trả JSON / file (đường dẫn API giữ như cũ). */

// Tác vụ nền: bận (đã có tác vụ chạy / hàng đợi đầy) trả 409 kèm {ok:false, error}.
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function resourceRoutes(app, ctx, res) {
  /* ---------- Font ---------- */
  app.get("/api/fonts", async () => res.fonts());

  // Tải thẳng dữ liệu file (không qua JSON); plugin riêng để bộ đọc "mọi kiểu dữ liệu" chỉ áp dụng cho các route tải lên.
  app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser("*", (req, payload, done) => done(null));
    upload.post("/api/fonts/upload", async (req) => res.uploadFont(req.raw, req.query.name, req.headers["content-length"]));
    // Trả mã để gọi /api/voices/create.
    upload.post("/api/voices/upload", async (req) => res.uploadVoice(req.raw, req.query.ext, req.headers["content-length"]));
  });

  app.post("/api/fonts/delete", async (req) => res.removeFont(String(req.body?.id || "")));

  // Trình duyệt tải font về để hiện chữ mẫu trên trang Tài nguyên
  app.get("/api/fonts/file", async (req, reply) => {
    const f = res.font(req.query.id);
    if (!f) return reply.code(404).send("Not found");
    return reply.header("Cache-Control", "public, max-age=86400").sendFile(f.file, res.fontsDir);
  });

  app.post("/api/sub-preview", async (req, reply) =>
    reply.type("image/jpeg").header("Cache-Control", "no-store").send(await res.subPreview(req.body || {}))
  );

  /* ---------- Mô hình nhận diện ---------- */
  app.get("/api/asr-models", async (req, reply) => {
    try {
      const refresh = ["1", "true"].includes(String(req.query?.refresh || "").toLowerCase());
      return await res.asrModels({ refresh });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message, models: [] });
    }
  });
  app.post("/api/asr-models/vad", async (req) => res.setVad(String(req.body?.id || "")));
  app.post("/api/asr-models/download", async (req, reply) => send(reply, res.downloadAsr(String(req.body?.id || ""))));

  /* ---------- Giọng đọc ---------- */
  app.get("/api/voices", async () => res.voices());

  app.post("/api/voices/create", async (req, reply) => {
    const r = await res.createVoice(req.body || {});
    return r.ok ? r : reply.code(400).send(r);
  });
  app.post("/api/voices/update", async (req) => res.updateVoice(req.body || {}));
  app.post("/api/voices/delete", async (req) => res.removeVoice(String(req.body?.slug || "")));

  // Đoạn giọng mẫu gốc của 1 giọng clone
  app.get("/api/voices/sample", async (req, reply) => {
    const name = res.sampleName(String(req.query.slug || ""));
    if (!name) return reply.code(404).send("Not found");
    return reply.sendFile(name, res.voicesDir);
  });

  // Máy đọc thử 1 câu bằng giọng đã chọn
  app.get("/api/voices/preview", async (req, reply) => {
    const r = await res.previewVoice(req.query.voice, req.query.text);
    return r.ok ? reply.sendFile(r.name, res.previewDir) : reply.code(500).send(r);
  });
}
