/** Thư viện giọng đọc (dùng chung mọi dự án). */
import fs from "node:fs";
import path from "node:path";
import { ROOT, VENV_PYTHON, VOICES_DIR, VOICES_JSON, VOICE_TMP_DIR } from "../config.mjs";
import { execFileP, nowIso, readJson, writeJson } from "./util.mjs";

const P = (kind, id, name, gender, desc) => ({ id, kind, name, gender, desc });
export const PRESET_VOICES = [
  ...[
    ["Thiện Minh", "male", "Bắc · kể chuyện"], ["Thiền Tâm Đức", "male", "Bắc · kể chuyện"], ["Hải Đăng", "male", "Bắc · tự nhiên"],
    ["Adam bựa", "male", "Bắc · tự nhiên"], ["Quang Sơn", "male", "Trung · tự nhiên"], ["Minh Đức", "male", "Bắc · tin tức"],
    ["Phạm Tuyên", "male", "Bắc · tự nhiên"], ["Thái Sơn", "male", "Nam · kể chuyện"], ["Xuân Vĩnh", "male", "Bắc · tự nhiên"],
    ["Thanh Bình", "male", "Bắc · kể chuyện"], ["Minh Triết", "male", "Nam · tin tức"], ["Đức Trí", "male", "Nam · đọc truyện"],
    ["Adam", "male", "Nam · tự nhiên"], ["Quốc Tuấn", "male", "Bắc · tự nhiên"],
    ["Ngọc Huyền", "female", "Bắc · tự nhiên"], ["Trúc Ly", "female", "Bắc · tự nhiên"], ["Quỳnh Anh", "female", "Bắc · đọc truyện"],
    ["Mai Anh", "female", "Bắc · tin tức"], ["Thùy Dung", "female", "Nam · tin tức"], ["Ngọc Trân", "female", "Trung · tự nhiên"],
    ["Ngọc Linh", "female", "Bắc · kể chuyện"], ["Đoan Trang", "female", "Bắc · tự nhiên"], ["Thục Đoan", "female", "Nam · kể chuyện"],
    ["Mỹ Duyên", "female", "Nam · đọc truyện"], ["Kim Thanh", "female", "Nam · đọc truyện"],
  ].map(([name, gender, desc]) => P("vieneu", `vieneu:${name}`, name, gender, desc)),
];

export const validSlug = (s) => /^[a-z0-9_-]{1,40}$/.test(String(s));

/** Danh sách giọng clone. File .wav thả tay vào data/voices/ cũng được tự nhận. */
export function listCloneVoices() {
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
}

export function voiceSlug(name, taken) {
  const base =
    String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "giong";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

/** Chạy voice_tool.py, trả JSON ở dòng cuối (kể cả khi lỗi: script in {ok:false,error} rồi thoát mã 1). */
export async function runVoiceTool(args, timeoutMs) {
  const parse = (out) => {
    try {
      return JSON.parse(String(out || "").trim().split("\n").pop());
    } catch {
      return null;
    }
  };
  try {
    const { stdout } = await execFileP(VENV_PYTHON, [path.join(ROOT, "voice_tool.py"), ...args], {
      cwd: ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    return parse(stdout) || { ok: false, error: "Công cụ giọng đọc không trả kết quả." };
  } catch (err) {
    return parse(err.stdout) || { ok: false, error: err.killed ? "Quá thời gian xử lý." : String(err.message).slice(0, 300) };
  }
}

// Nghe thử nạp mô hình VieNeu (nặng): xếp hàng từng yêu cầu một.
let previewQueue = Promise.resolve();
export function queuePreview(fn) {
  const job = previewQueue.then(fn);
  previewQueue = job.catch(() => {});
  return job;
}

export function clearVoiceTmp() {
  fs.rmSync(VOICE_TMP_DIR, { recursive: true, force: true }); // file tải lên dở của lần chạy trước
}
