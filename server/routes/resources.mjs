/** Tài nguyên dùng chung mọi dự án: font chữ phụ đề (tải lên / có sẵn trong máy) + xem trước phụ đề trên khung hình. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ROOT, VENV_PYTHON } from "../config.mjs";
import { FONTS_DIR, FONT_EXTS, MAX_FONT_BYTES, addFont, checkSubStyle, listFonts, removeFont, systemFonts, validFontId } from "../lib/fonts.mjs";
import { dubBusyError } from "../lib/tasks.mjs";
import { execFileP, fail, resolveDownload, validSubcover } from "../lib/util.mjs";

// Xem trước chạy ffmpeg: xếp hàng từng yêu cầu một để gõ nhanh không dồn hàng chục tiến trình.
let previewChain = Promise.resolve();

export default async function resourceRoutes(app) {
  app.get("/api/fonts", async () => ({ ok: true, fonts: listFonts(), system: await systemFonts() }));

  // Tải thẳng dữ liệu file (không qua JSON); plugin riêng để bộ đọc "mọi kiểu dữ liệu" chỉ áp dụng cho route này.
  app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser("*", (req, payload, done) => done(null));
    upload.post("/api/fonts/upload", async (req, reply) => {
      const original = path.basename(String(req.query.name || "font.ttf"));
      const ext = path.extname(original).slice(1).toLowerCase();
      if (!FONT_EXTS.includes(ext)) return fail(reply, 400, `Chỉ nhận file font ${FONT_EXTS.join(", ")}.`);
      if (Number(req.headers["content-length"]) > MAX_FONT_BYTES) return fail(reply, 413, "File font lớn hơn 40 MB.");
      fs.mkdirSync(FONTS_DIR, { recursive: true });
      const tmp = path.join(FONTS_DIR, `.upload-${crypto.randomBytes(6).toString("hex")}.${ext}`);
      let size = 0;
      try {
        await pipeline(
          req.raw,
          async function* (src) {
            for await (const chunk of src) {
              size += chunk.length;
              if (size > MAX_FONT_BYTES) throw Object.assign(new Error("File font lớn hơn 40 MB."), { statusCode: 413 });
              yield chunk;
            }
          },
          fs.createWriteStream(tmp)
        );
        return { ok: true, font: await addFont(tmp, ext, original) };
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        const code = err.statusCode || 400;
        return fail(reply, code, code === 400 ? "File này không phải font hợp lệ." : err.message);
      }
    });
  });

  app.post("/api/fonts/delete", async (req, reply) => {
    const id = String(req.body?.id || "");
    if (!validFontId(id)) return fail(reply, 400, "Font không hợp lệ.");
    if (dubBusyError()) return fail(reply, 409, "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa font.");
    return removeFont(id) ? { ok: true } : fail(reply, 404, "Không tìm thấy font.");
  });

  // Trình duyệt tải font về để hiện chữ mẫu trên trang Tài nguyên
  app.get("/api/fonts/file", async (req, reply) => {
    const f = listFonts().find((x) => x.id === String(req.query.id || ""));
    if (!f) return reply.code(404).send("Not found");
    return reply.header("Cache-Control", "public, max-age=86400").sendFile(f.file, FONTS_DIR);
  });

  // Ảnh xem trước: 1 khung hình của video + phụ đề mẫu, vẽ bằng đúng bộ lọc sẽ dùng khi xuất.
  app.post("/api/sub-preview", async (req, reply) => {
    const body = req.body || {};
    const video = resolveDownload(body.rel_path);
    if (!video || !fs.existsSync(video)) return fail(reply, 400, "Video không hợp lệ.");
    if (body.subcover !== undefined && !validSubcover(body.subcover)) return fail(reply, 400, "Vùng che phụ đề không hợp lệ.");
    const checked = checkSubStyle(body.style);
    if (checked.error) return fail(reply, 400, checked.error);
    const out = path.join(os.tmpdir(), `openreup-subprev-${crypto.randomBytes(6).toString("hex")}.jpg`);
    const args = [path.join(ROOT, "subtitles.py"), "preview", "--input", video, "--out", out, "--subcover", String(body.subcover || "none")];
    if (checked.style) args.push("--style", JSON.stringify(checked.style));
    if (body.text) args.push("--text", String(body.text).slice(0, 160));
    if (body.burn === false) args.push("--no-sub"); // đang tắt in phụ đề: chỉ cho xem vùng che
    const job = previewChain.then(async () => {
      try {
        await execFileP(VENV_PYTHON, args, { cwd: ROOT, timeout: 60_000 });
        return fs.readFileSync(out);
      } catch (err) {
        let msg = "Không vẽ được bản xem trước.";
        try { msg = JSON.parse(String(err.stdout).trim().split("\n").pop()).error || msg; } catch {}
        throw Object.assign(new Error(msg), { statusCode: 500 });
      } finally {
        fs.rmSync(out, { force: true });
      }
    });
    previewChain = job.catch(() => {});
    return reply.type("image/jpeg").header("Cache-Control", "no-store").send(await job);
  });
}
