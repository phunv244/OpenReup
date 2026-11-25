/** Đường dẫn và hằng số dùng chung của server. */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
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
export const TASK_LOG = path.join(DATA_DIR, "last_task.log");
export const DOWNLOADS_DIR = path.join(ROOT, "downloads");
export const BILIBILI_DIR = path.join(DOWNLOADS_DIR, "bilibili");
export const DUBBED_DIR = path.join(DOWNLOADS_DIR, "dubbed");
export const VENV_PYTHON = path.join(ROOT, ".venv", "bin", "python");
export const WEB_OUT_DIR = path.join(ROOT, "web", "out"); // bản build của giao diện Next.js
export const PORT = Number(process.env.PORT || 3456);
export const HOST = process.env.HOST || "127.0.0.1";

export const DEFAULT_CHANNEL_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";
export const DEFAULT_VOICE = "vieneu:Thiện Minh";
