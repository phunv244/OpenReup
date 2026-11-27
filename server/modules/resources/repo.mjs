/**
 * Đọc/ghi dữ liệu của module resources (đều nằm dưới REUP_DATA_DIR):
 * data/fonts/ + data/fonts.json (font tải lên), data/voices/ + data/voices.json (giọng clone, _tmp tải lên dở, _preview nghe thử).
 * Gọi script Python dùng chung: asr.py (mô hình nhận diện), voice_tool.py (clone/nghe thử), subtitles.py (xem trước phụ đề).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DATA_DIR, PY_SCRIPTS, ROOT, VENV_PYTHON, VOICES_DIR, VOICES_JSON, VOICE_PREVIEW_DIR, VOICE_TMP_DIR } from "../../config.mjs";
import { validFontFamily } from "../../lib/fonts.mjs";
import { execFileP, nowIso, readJson, writeJson } from "../../lib/util.mjs";

const FONTS_DIR = path.join(DATA_DIR, "fonts");
const FONTS_JSON = path.join(DATA_DIR, "fonts.json");
const tooBig = (message) => Object.assign(new Error(message), { statusCode: 413 });

/** Tên an toàn cho file (bỏ dấu, chữ thường, gạch nối), tránh trùng với taken. */
function slugify(name, taken, { max, fallback }) {
  const base = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || fallback;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Dòng JSON cuối của stdout một script Python (script in {ok:false,error} rồi thoát mã 1 khi lỗi). */
function lastJson(out) {
  try {
    return JSON.parse(String(out || "").trim().split("\n").pop());
  } catch {
    return null;
  }
}

/** Xếp hàng từng việc một (ffmpeg / mô hình VieNeu nặng: gõ nhanh không dồn hàng chục tiến trình). */
function serialQueue() {
  let chain = Promise.resolve();
  return (fn) => {
    const job = chain.then(fn);
    chain = job.catch(() => {});
    return job;
  };
}
const previewQueue = serialQueue();
const subPreviewQueue = serialQueue();

export const resourceRepo = {
  FONTS_DIR,
  VOICES_DIR,
  VOICE_PREVIEW_DIR,

  /** Ghi luồng tải lên ra file, quá maxBytes thì dừng (lỗi 413); lỗi thì xóa file dở. */
  async saveUpload(src, file, maxBytes, tooBigMessage) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      await pipeline(
        src,
        async function* (chunks) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > maxBytes) throw tooBig(tooBigMessage);
            yield chunk;
          }
        },
        fs.createWriteStream(file)
      );
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  },
  removeFile: (file) => fs.rmSync(file, { force: true }),
  exists: (file) => fs.existsSync(file),
  mtimeMs: (file) => fs.statSync(file).mtimeMs,

  /* ---------- Font ---------- */
  fontTmpFile: (ext) => path.join(FONTS_DIR, `.upload-${crypto.randomBytes(6).toString("hex")}.${ext}`),
  listFonts: () => readJson(FONTS_JSON, []).filter((f) => fs.existsSync(path.join(FONTS_DIR, f.file))),

  /** Đọc tên họ font + hỗ trợ tiếng Việt bằng fc-scan; ném lỗi nếu không phải file font. */
  async scanFont(file) {
    const { stdout } = await execFileP("fc-scan", ["--format", "%{family}@@%{style}@@%{lang}\\n", file], { timeout: 20_000 });
    const first = stdout.split("\n").find((l) => l.trim());
    if (!first) throw new Error("Không đọc được font này.");
    const [family, style, lang] = first.split("@@"); // %{lang} tự dùng "|" ngăn các ngôn ngữ nên không dùng "|" làm dấu tách
    const name = family.split(",")[0].trim();
    if (!name) throw new Error("Font không có tên họ.");
    return { family: name, style: (style || "").split(",")[0].trim(), vi: String(lang).split("|").includes("vi") };
  },

  /** Chuyển file tạm vào data/fonts/ và ghi vào fonts.json. */
  addFont(tmpFile, ext, info, originalName) {
    const fonts = resourceRepo.listFonts();
    const id = slugify(`${info.family}-${info.style}`, new Set(fonts.map((f) => f.id)), { max: 40, fallback: "font" });
    const file = `${id}.${ext}`;
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    fs.renameSync(tmpFile, path.join(FONTS_DIR, file));
    const font = {
      id, file, family: info.family, style: info.style, vi: info.vi, original_name: String(originalName).slice(0, 120),
      size_kb: Math.round(fs.statSync(path.join(FONTS_DIR, file)).size / 1024), created_at: nowIso(),
    };
    writeJson(FONTS_JSON, [...fonts, font]);
    return font;
  },

  removeFont(id) {
    const fonts = resourceRepo.listFonts();
    const f = fonts.find((x) => x.id === id);
    if (!f) return false;
    fs.rmSync(path.join(FONTS_DIR, f.file), { force: true });
    writeJson(FONTS_JSON, fonts.filter((x) => x.id !== id));
    return true;
  },

  /** Họ font tiếng Việt dùng được có sẵn trong máy (fontconfig), cache 5 phút. */
  systemFonts: (() => {
    let cache = { at: 0, list: [] };
    return async () => {
      if (Date.now() - cache.at < 300_000) return cache.list;
      try {
        const { stdout } = await execFileP("fc-list", [":lang=vi", "family"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
        const names = new Set();
        for (const line of stdout.split("\n")) {
          const n = line.split(",")[0].trim();
          if (n && validFontFamily(n)) names.add(n);
        }
        cache = { at: Date.now(), list: [...names].sort((a, b) => a.localeCompare(b)) };
      } catch {
        cache = { at: Date.now(), list: [] };
      }
      return cache.list;
    };
  })(),

  /** Vẽ 1 khung hình + phụ đề mẫu bằng subtitles.py (xếp hàng); trả Buffer JPEG hoặc ném lỗi 500 kèm câu lỗi của script. */
  renderSubPreview(args) {
    return subPreviewQueue(async () => {
      const out = path.join(os.tmpdir(), `openreup-subprev-${crypto.randomBytes(6).toString("hex")}.jpg`);
      try {
        await execFileP(VENV_PYTHON, [PY_SCRIPTS.subtitles, "preview", ...args, "--out", out], { cwd: ROOT, timeout: 60_000 });
        return fs.readFileSync(out);
      } catch (err) {
        // Script chết trước khi in JSON (vd không mở được file script): kèm dòng stderr cuối để biết nguyên nhân.
        const tail = String(err.stderr || "").trim().split("\n").pop().slice(0, 200);
        const msg = lastJson(err.stdout)?.error || `Không vẽ được bản xem trước.${tail ? ` (${tail})` : ""}`;
        throw Object.assign(new Error(msg), { statusCode: 500 });
      } finally {
        fs.rmSync(out, { force: true });
      }
    });
  },

  /* ---------- Mô hình nhận diện (asr.py) ---------- */
  asrScript: PY_SCRIPTS.asr,
  runAsr: (args) => execFileP(VENV_PYTHON, [resourceRepo.asrScript, ...args], { cwd: ROOT, timeout: 30000 }),

  /* ---------- Giọng đọc ---------- */
  voiceTmpFile: (name) => path.join(VOICE_TMP_DIR, path.basename(String(name))),
  newVoiceTmpFile: (ext) => path.join(VOICE_TMP_DIR, `${crypto.randomBytes(8).toString("hex")}.${ext}`),
  voiceWav: (slug) => path.join(VOICES_DIR, `${slug}.wav`),
  previewFile: (key) => path.join(VOICE_PREVIEW_DIR, `${key}.mp3`),

  /** Danh sách giọng clone. File .wav thả tay vào data/voices/ cũng được tự nhận. */
  listCloneVoices(validSlug) {
    const voices = readJson(VOICES_JSON, []).filter((v) => fs.existsSync(path.join(VOICES_DIR, `${v.slug}.wav`)));
    let added = false;
    if (fs.existsSync(VOICES_DIR)) {
      for (const f of fs.readdirSync(VOICES_DIR)) {
        const slug = f.replace(/\.wav$/, "");
        if (!f.endsWith(".wav") || !validSlug(slug) || voices.some((v) => v.slug === slug)) continue;
        voices.push({ slug, name: slug, gender: "", source: "File có sẵn", created_at: nowIso() });
        added = true;
      }
    }
    if (added) writeJson(VOICES_JSON, voices);
    return voices;
  },
  readVoicesRaw: () => readJson(VOICES_JSON, []),
  writeVoices: (voices) => writeJson(VOICES_JSON, voices),
  voiceSlug: (name, taken) => slugify(name, taken, { max: 32, fallback: "giong" }),

  /** Chạy voice_tool.py, trả JSON ở dòng cuối (kể cả khi lỗi). */
  async runVoiceTool(args, timeoutMs) {
    try {
      const { stdout } = await execFileP(VENV_PYTHON, [PY_SCRIPTS.voice, ...args], {
        cwd: ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      });
      return lastJson(stdout) || { ok: false, error: "Công cụ giọng đọc không trả kết quả." };
    } catch (err) {
      return lastJson(err.stdout) || { ok: false, error: err.killed ? "Quá thời gian xử lý." : String(err.message).slice(0, 300) };
    }
  },
  queuePreview: previewQueue,

  /** File tải lên dở của lần chạy trước. */
  clearVoiceTmp: () => fs.rmSync(VOICE_TMP_DIR, { recursive: true, force: true }),
};
