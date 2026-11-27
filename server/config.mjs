/** Đường dẫn và hằng số dùng chung của server. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENV_BIN = path.join(ROOT, ".venv", "bin");
if (fs.existsSync(VENV_BIN) && !(process.env.PATH || "").split(path.delimiter).includes(VENV_BIN)) {
  process.env.PATH = `${VENV_BIN}${path.delimiter}${process.env.PATH || ""}`;
}
// REUP_DATA_DIR: chỉ dùng cho test (DB + JSON tạm), mặc định là data/ trong repo.
export const DATA_DIR = process.env.REUP_DATA_DIR ? path.resolve(process.env.REUP_DATA_DIR) : path.join(ROOT, "data");
export const DATA_JSON = path.join(DATA_DIR, "videos.json");
export const BILIBILI_JSON = path.join(DATA_DIR, "bilibili.json");
export const DUBBED_JSON = path.join(DATA_DIR, "dubbed.json");
export const DUB_PROJECTS_DIR = path.join(DATA_DIR, "dub_projects");
export const VIDEO_PROJECTS_JSON = path.join(DATA_DIR, "video_projects.json"); // {rel_path: project_id}
export const VOICES_JSON = path.join(DATA_DIR, "voices.json");
export const VOICES_DIR = path.join(DATA_DIR, "voices");
export const VOICE_TMP_DIR = path.join(VOICES_DIR, "_tmp");
export const VOICE_PREVIEW_DIR = path.join(VOICES_DIR, "_preview");
export const DB_PATH = path.join(DATA_DIR, "openreup.db");
export const DUB_WORK_DIR = path.join(DATA_DIR, "dub_work");
export const STORY_PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
export const MEDIA_CACHE_JSON = path.join(DATA_DIR, "media_cache.json");
// Bố cục mới: mỗi video một thư mục data/videos/<video_key>/ (docs/video-folder-layout.md). Cố ý không có biến môi trường riêng (8.1).
export const VIDEOS_DIR = path.join(DATA_DIR, "videos");
export const TASK_LOG = path.join(DATA_DIR, "last_task.log");
// REUP_MEDIA_ROOT: chỉ dùng cho test — thư mục chứa downloads/ (video tải về + bản xuất downloads/dubbed), mặc định là repo.
// Đường dẫn tương đối "downloads/..." (khóa trong video_projects.json, rel_path của API) luôn tính từ MEDIA_ROOT.
export const MEDIA_ROOT = process.env.REUP_MEDIA_ROOT ? path.resolve(process.env.REUP_MEDIA_ROOT) : ROOT;
export const DOWNLOADS_DIR = path.join(MEDIA_ROOT, "downloads");
export const BILIBILI_DIR = path.join(DOWNLOADS_DIR, "bilibili");
export const DUBBED_DIR = path.join(DOWNLOADS_DIR, "dubbed");
// REUP_PYTHON: chỉ dùng cho test (thay python bằng script giả), mặc định là .venv của repo.
export const VENV_PYTHON = process.env.REUP_PYTHON || path.join(ROOT, ".venv", "bin", "python");
export const WEB_OUT_DIR = path.join(ROOT, "web", "out"); // bản build của giao diện Next.js
export const PORT = Number(process.env.PORT || 3456);
export const HOST = process.env.HOST || "127.0.0.1";
// Bắt buộc khi mở server ra ngoài máy (HOST khác localhost): mọi request ghi vào /api/ phải gửi "Authorization: Bearer <token>".
export const API_TOKEN = String(process.env.REUP_API_TOKEN || "").trim();
export const LOCAL_ONLY = ["127.0.0.1", "localhost", "::1"].includes(HOST);

export const DEFAULT_CHANNEL_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";
export const DEFAULT_VOICE = "vieneu:Thiện Minh";
