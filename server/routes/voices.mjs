/** Giọng đọc: danh sách, clone, nghe thử. Mô hình nhận diện (ASR) + bộ lọc VAD. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ROOT, STORY_PROJECTS_DIR, VENV_PYTHON, VOICES_DIR, VOICES_JSON, VOICE_PREVIEW_DIR, VOICE_TMP_DIR } from "../config.mjs";
import { dubBusyError, spawnTask } from "../lib/tasks.mjs";
import {
  execFileP, fail, nowIso, projectFile, readJson, resolveDownload, validModelId, validVoice, writeJson,
} from "../lib/util.mjs";
import { PRESET_VOICES, listCloneVoices, queuePreview, runVoiceTool, validSlug, voiceSlug } from "../lib/voices.mjs";

const MAX_UPLOAD = 500 * 1024 * 1024;
const asrPy = path.join(ROOT, "asr.py");

export default async function voiceRoutes(app) {
  /* ---------- Mô hình nhận diện ---------- */
  app.get("/api/asr-models", async (req, reply) => {
    try {
      const { stdout } = await execFileP(VENV_PYTHON, [asrPy, "list"], { cwd: ROOT, timeout: 30000 });
      return JSON.parse(stdout);
    } catch (err) {
      return reply.code(500).send({ ok: false, error: `Không đọc được danh sách mô hình: ${String(err.message).slice(0, 200)}`, models: [] });
    }
  });

  app.post("/api/asr-models/vad", async (req, reply) => {
    const id = String(req.body?.id || "");
    if (!validModelId(id)) return fail(reply, 400, "Bộ lọc không hợp lệ.");
    try {
      await execFileP(VENV_PYTHON, [asrPy, "set-vad", id], { cwd: ROOT, timeout: 30000 });
      return { ok: true };
    } catch {
      return fail(reply, 400, "Bộ lọc giọng nói này chưa tải hoặc không tồn tại.");
    }
  });

  app.post("/api/asr-models/download", async (req, reply) => {
    const id = String(req.body?.id || "");
    if (!validModelId(id)) return fail(reply, 400, "Mô hình không hợp lệ.");
    const result = spawnTask("asr_download", VENV_PYTHON, ["-u", asrPy, "download", id], id);
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  /* ---------- Giọng đọc ---------- */
  app.get("/api/voices", async () => ({
    clones: listCloneVoices().map((v) => ({ ...v, id: `vieneu-clone:${v.slug}`, kind: "clone" })),
    presets: PRESET_VOICES,
  }));

  // Nhận thẳng dữ liệu file (không qua JSON) rồi ghi ra thư mục tạm; trả mã để gọi /api/voices/create.
  // Đặt trong plugin riêng: bộ đọc "mọi kiểu dữ liệu" chỉ áp dụng cho route này.
  app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser("*", (req, payload, done) => done(null));
    upload.post("/api/voices/upload", async (req, reply) => {
      const ext = String(req.query.ext || "").toLowerCase();
      if (!/^(mp3|wav|m4a|aac|flac|ogg|opus|mp4|mkv|webm|mov)$/.test(ext)) {
        return fail(reply, 400, "Chỉ nhận file âm thanh / video (mp3, wav, m4a, mp4...).");
      }
      if (Number(req.headers["content-length"]) > MAX_UPLOAD) return fail(reply, 413, "File lớn hơn 500 MB.");
      fs.mkdirSync(VOICE_TMP_DIR, { recursive: true });
      const token = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const file = path.join(VOICE_TMP_DIR, token);
      let size = 0;
      try {
        await pipeline(
          req.raw,
          async function* (src) {
            for await (const chunk of src) {
              size += chunk.length;
              if (size > MAX_UPLOAD) throw Object.assign(new Error("File lớn hơn 500 MB."), { statusCode: 413 });
              yield chunk;
            }
          },
          fs.createWriteStream(file)
        );
      } catch (err) {
        fs.rmSync(file, { force: true });
        return fail(reply, err.statusCode || 500, err.message);
      }
      return { ok: true, token };
    });
  });

  app.post("/api/voices/create", async (req, reply) => {
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 60);
    let src = "";
    let source = "";
    let tmpFile = "";
    if (body.upload) {
      tmpFile = src = path.join(VOICE_TMP_DIR, path.basename(String(body.upload)));
      source = `Tải lên: ${String(body.upload_name || "").slice(0, 80)}`;
      if (!fs.existsSync(src)) src = "";
    } else if (body.rel_path) {
      src = resolveDownload(body.rel_path);
      source = `Video: ${path.basename(String(body.rel_path))}`;
      if (src && !fs.existsSync(src)) src = "";
    } else if (/^https?:\/\/\S+$/i.test(String(body.url || "").trim())) {
      src = source = String(body.url).trim();
    }
    if (!name || !src) return fail(reply, 400, !name ? "Hãy đặt tên cho giọng." : "Nguồn âm thanh không hợp lệ.");
    const slug = voiceSlug(name, new Set(listCloneVoices().map((v) => v.slug)));
    const args = ["clone", "--src", src, "--out", path.join(VOICES_DIR, `${slug}.wav`)];
    const manual = body.start !== undefined && body.start !== "" && body.end !== undefined && body.end !== "";
    if (manual) args.push("--start", String(Number(body.start) || 0), "--end", String(Number(body.end) || 0));
    const r = await runVoiceTool(args, 15 * 60 * 1000);
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
    if (!r.ok) return reply.code(400).send(r);
    const voice = {
      slug, name, gender: ["male", "female"].includes(body.gender) ? body.gender : r.gender, f0: r.f0, source,
      start: r.start, end: r.end, created_at: nowIso(),
    };
    writeJson(VOICES_JSON, [...listCloneVoices().filter((v) => v.slug !== slug), voice]);
    // Thêm luôn vào dự án đang mở
    const projFile = projectFile(body.project_id);
    if (body.project_id && fs.existsSync(projFile)) {
      const proj = readJson(projFile, {});
      proj.voices = [...new Set([...(proj.voices || []), `vieneu-clone:${slug}`])];
      writeJson(projFile, proj);
    }
    return { ok: true, voice: { ...voice, id: `vieneu-clone:${slug}`, kind: "clone" } };
  });

  app.post("/api/voices/update", async (req, reply) => {
    const body = req.body || {};
    const voices = listCloneVoices();
    const v = voices.find((x) => x.slug === body.slug);
    if (!v) return fail(reply, 404, "Không tìm thấy giọng.");
    if (body.name !== undefined) v.name = String(body.name).trim().slice(0, 60) || v.name;
    if (["male", "female", ""].includes(body.gender)) v.gender = body.gender;
    writeJson(VOICES_JSON, voices);
    return { ok: true };
  });

  app.post("/api/voices/delete", async (req, reply) => {
    const slug = String(req.body?.slug || "");
    if (!validSlug(slug)) return fail(reply, 400, "Giọng không hợp lệ.");
    if (dubBusyError()) return fail(reply, 409, "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa giọng.");
    fs.rmSync(path.join(VOICES_DIR, `${slug}.wav`), { force: true });
    writeJson(VOICES_JSON, readJson(VOICES_JSON, []).filter((v) => v.slug !== slug));
    // Gỡ khỏi mọi dự án đang chọn giọng này
    if (fs.existsSync(STORY_PROJECTS_DIR)) {
      for (const f of fs.readdirSync(STORY_PROJECTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        const file = path.join(STORY_PROJECTS_DIR, f);
        const proj = readJson(file, null);
        if (proj?.voices?.includes(`vieneu-clone:${slug}`)) {
          proj.voices = proj.voices.filter((x) => x !== `vieneu-clone:${slug}`);
          writeJson(file, proj);
        }
      }
    }
    return { ok: true };
  });

  // Đoạn giọng mẫu gốc của 1 giọng clone
  app.get("/api/voices/sample", async (req, reply) => {
    const slug = String(req.query.slug || "");
    if (!validSlug(slug)) return reply.code(404).send("Not found");
    return reply.sendFile(`${slug}.wav`, VOICES_DIR);
  });

  // Máy đọc thử 1 câu bằng giọng đã chọn; kết quả được giữ lại theo (giọng, câu).
  app.get("/api/voices/preview", async (req, reply) => {
    const voice = String(req.query.voice || "");
    const text = String(req.query.text || "").trim().slice(0, 200);
    if (!validVoice(voice) || !/\p{L}/u.test(text)) return fail(reply, 400, "Giọng hoặc câu nghe thử không hợp lệ.");
    let stamp = "";
    if (voice.startsWith("vieneu-clone:")) {
      const wav = path.join(VOICES_DIR, `${voice.split(":")[1]}.wav`);
      if (!fs.existsSync(wav)) return fail(reply, 404, "Không tìm thấy giọng.");
      stamp = String(fs.statSync(wav).mtimeMs); // clone lại cùng tên thì không phát bản nghe thử cũ
    }
    const key = crypto.createHash("sha1").update(`${voice}|${stamp}|${text}`).digest("hex");
    const out = path.join(VOICE_PREVIEW_DIR, `${key}.mp3`);
    if (!fs.existsSync(out)) {
      const r = await queuePreview(() =>
        fs.existsSync(out) ? { ok: true } : runVoiceTool(["preview", "--voice", voice, "--text", text, "--out", out], 5 * 60 * 1000)
      );
      if (!r.ok) return reply.code(500).send(r);
    }
    return reply.sendFile(`${key}.mp3`, VOICE_PREVIEW_DIR);
  });
}
