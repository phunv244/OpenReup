/** Font chữ cho phụ đề: font người dùng tải lên (data/fonts/) + font tiếng Việt có sẵn trong máy (fontconfig). */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.mjs";
import { execFileP, nowIso, readJson, writeJson } from "./util.mjs";

export const FONTS_DIR = path.join(DATA_DIR, "fonts");
const FONTS_JSON = path.join(DATA_DIR, "fonts.json");
export const FONT_EXTS = ["ttf", "otf", "ttc", "otc"];
export const MAX_FONT_BYTES = 40 * 1024 * 1024;

export const validFontId = (v) => /^[a-z0-9][a-z0-9_-]{0,60}$/.test(String(v));
// Tên họ font đi vào file ASS: chặn ký tự phá cú pháp (dấu phẩy, ngoặc nhọn, xuống dòng...).
export const validFontFamily = (v) => /^[\p{L}\p{N} ._+()'-]{1,80}$/u.test(String(v));

export function listFonts() {
  return readJson(FONTS_JSON, []).filter((f) => fs.existsSync(path.join(FONTS_DIR, f.file)));
}

/** Đọc tên họ font + hỗ trợ tiếng Việt bằng fc-scan; ném lỗi nếu không phải file font. */
export async function scanFont(file) {
  const { stdout } = await execFileP("fc-scan", ["--format", "%{family}@@%{style}@@%{lang}\\n", file], { timeout: 20_000 });
  const first = stdout.split("\n").find((l) => l.trim());
  if (!first) throw new Error("Không đọc được font này.");
  const [family, style, lang] = first.split("@@"); // %{lang} tự dùng "|" ngăn các ngôn ngữ nên không dùng "|" làm dấu tách
  const name = family.split(",")[0].trim();
  if (!name) throw new Error("Font không có tên họ.");
  return { family: name, style: (style || "").split(",")[0].trim(), vi: String(lang).split("|").includes("vi") };
}

export function fontSlug(name, taken) {
  const base = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "font";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export async function addFont(tmpFile, ext, originalName) {
  const info = await scanFont(tmpFile);
  const fonts = listFonts();
  if (fonts.some((f) => f.family.toLowerCase() === info.family.toLowerCase() && f.style === info.style)) {
    throw Object.assign(new Error(`Font "${info.family}" đã có trong tài nguyên.`), { statusCode: 409 });
  }
  const id = fontSlug(`${info.family}-${info.style}`, new Set(fonts.map((f) => f.id)));
  const file = `${id}.${ext}`;
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  fs.renameSync(tmpFile, path.join(FONTS_DIR, file));
  const font = {
    id, file, family: info.family, style: info.style, vi: info.vi, original_name: String(originalName).slice(0, 120),
    size_kb: Math.round(fs.statSync(path.join(FONTS_DIR, file)).size / 1024), created_at: nowIso(),
  };
  writeJson(FONTS_JSON, [...fonts, font]);
  return font;
}

export function removeFont(id) {
  const fonts = listFonts();
  const f = fonts.find((x) => x.id === id);
  if (!f) return false;
  fs.rmSync(path.join(FONTS_DIR, f.file), { force: true });
  writeJson(FONTS_JSON, fonts.filter((x) => x.id !== id));
  return true;
}

let sysCache = { at: 0, list: [] };
/** Họ font tiếng Việt dùng được có sẵn trong máy (fontconfig), cache 5 phút. */
export async function systemFonts() {
  if (Date.now() - sysCache.at < 300_000) return sysCache.list;
  try {
    const { stdout } = await execFileP("fc-list", [":lang=vi", "family"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const names = new Set();
    for (const line of stdout.split("\n")) {
      const n = line.split(",")[0].trim();
      if (n && validFontFamily(n)) names.add(n);
    }
    sysCache = { at: Date.now(), list: [...names].sort((a, b) => a.localeCompare(b)) };
  } catch {
    sysCache = { at: Date.now(), list: [] };
  }
  return sysCache.list;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Kiểu phụ đề từ giao diện: null/undefined = mặc định; sai định dạng thì trả chuỗi lỗi. Trả {style} nếu hợp lệ. */
export function checkSubStyle(raw) {
  if (raw == null || raw === "") return { style: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "Kiểu phụ đề không hợp lệ." };
  const s = {};
  if (raw.font !== undefined) {
    if (!validFontFamily(raw.font)) return { error: "Tên font không hợp lệ." };
    s.font = String(raw.font);
  }
  for (const k of ["color", "bg", "outline"]) {
    if (raw[k] !== undefined) {
      if (!HEX.test(String(raw[k]))) return { error: "Màu phải có dạng #RRGGBB." };
      s[k] = String(raw[k]).toUpperCase();
    }
  }
  const nums = { size_pct: [40, 250], bg_opacity: [0, 100], outline_width: [0, 12] };
  for (const [k, [lo, hi]] of Object.entries(nums)) {
    if (raw[k] !== undefined) {
      const n = Number(raw[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) return { error: `Giá trị ${k} phải từ ${lo} đến ${hi}.` };
      s[k] = n;
    }
  }
  if (raw.bold !== undefined) s.bold = Boolean(raw.bold);
  return { style: Object.keys(s).length ? s : null };
}
