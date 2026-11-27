/** Đọc/ghi JSON, kiểm tra dữ liệu đầu vào, gọi tiến trình con. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STORY_PROJECTS_DIR } from "../config.mjs";
import { lookupDownload, relOfPath } from "./videos.mjs";

export const execFileP = promisify(execFile);

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Ghi qua file tạm rồi đổi tên: server bị tắt giữa chừng cũng không làm hỏng file dữ liệu. */
export function writeJson(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), "utf8");
  fs.renameSync(tmp, file);
}

/** Trả lỗi dạng {ok:false, error} mà giao diện đang đọc. */
export const fail = (reply, code, error) => reply.code(code).send({ ok: false, error });

/** job_id chỉ gồm chữ/số/_/- : chặn "." và ".." (path.basename không chặn) trước khi dùng để xóa thư mục. */
export function safeJobId(value) {
  const id = path.basename(String(value || ""));
  return /^[0-9A-Za-z_-]+$/.test(id) ? id : "";
}

// Giọng đọc: preset VieNeu hoặc giọng clone trong data/voices (đi thẳng vào tham số dòng lệnh).
export const validVoice = (v) => /^(vieneu:[\p{L} ]{1,40}|vieneu-clone:[a-z0-9_-]{1,40})$/u.test(String(v));
// Vị trí logo: preset hoặc vùng pixel "x,y,w,h". Đi thẳng vào filter ffmpeg nên phải chặn chuỗi lạ.
export const validDelogo = (v) => /^(none|top-right|top-left|both-top|\d{1,5},\d{1,5},\d{1,5},\d{1,5})$/.test(String(v));
// Vùng che phụ đề gốc: chỉ "none" hoặc vùng pixel x,y,w,h (đi vào filter ffmpeg).
export const validSubcover = (v) => /^(none|\d{1,5},\d{1,5},\d{1,5},\d{1,5})$/.test(String(v));
export const validModelId = (v) => /^[a-z0-9.-]{1,40}$/.test(String(v));

/**
 * rel_path "downloads/..." → đường dẫn thật (bố cục mới qua chỉ mục video.json, không có thì downloads/ cũ).
 * Chỉ chấp nhận khóa nằm trong downloads/ (chống ../). Trả về đường dẫn tuyệt đối hoặc "".
 * Cần biết file là nguồn hay bản xuất thì dùng lookupDownload (lib/videos.mjs).
 */
export const resolveDownload = (rel) => lookupDownload(rel)?.abs || "";

/** Đường dẫn thật → rel_path kiểu "downloads/bilibili/x.mp4" (khóa trong video_projects.json), cả ở bố cục mới. */
export const relOf = (full) => relOfPath(full);

export const projectFile = (id) => path.join(STORY_PROJECTS_DIR, `${path.basename(String(id || ""))}.json`);

/** project_id gửi kèm khi tải video — chỉ nhận dự án có thật. */
export function projectIdOf(body) {
  const pid = path.basename(String(body.project_id || ""));
  return pid && fs.existsSync(projectFile(pid)) ? pid : "";
}

export const nowIso = () => new Date().toISOString().slice(0, 19);

/** Đường dẫn trả cho model: tuyệt đối (mở file) + tương đối (truyền lại vào hàm khác) + url xem trên Studio. */
export const fileInfo = (abs) => ({ path: abs, rel_path: relOf(abs), url: "/" + relOf(abs).split("/").map(encodeURIComponent).join("/") });
