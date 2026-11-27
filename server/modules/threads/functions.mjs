/** Hàm /api/functions (MCP / Code Mode) của module Threads. */
import { P_DELOGO, P_SUBCOVER, P_VOICE, bool, num, str } from "../../core/schema.mjs";
import { threadsRepo } from "./repo.mjs";

export const THREADS_FUNCTIONS = [
  {
    name: "threads_video_pipeline",
    description:
      "Tạo video dọc 1080x1920 @ 60fps từ bài viết chữ/ảnh trên Threads (VideoThreads: cào 2 tầng, AI Director không scoring, VieNeu-TTS 48kHz -14 LUFS, Remotion). Chạy nền trên GPU queue chung.",
    route: ["POST", "/api/threads/video"],
    task: true,
    result: (_a, ev) => ({ saved_files: ev.saved_files || [] }),
    parameters: {
      url: str("Link bài viết Threads công khai (https://www.threads.net/@user/post/xyz)."),
      voice: P_VOICE,
      theme: str("Giao diện thẻ Threads: dark hoặc light.", { enum: ["dark", "light"], default: "dark" }),
      fps: num("Tốc độ khung hình xuất video (30 hoặc 60).", { default: 60, minimum: 30, maximum: 60 }),
      max_comments: num("Số bình luận tối đa đưa vào video (1–5).", { default: 5, minimum: 1, maximum: 5 }),
      background_video_path: str("Đường dẫn video nền gameplay (tùy chọn)."),
    },
    required: ["url"],
  },
  {
    name: "threads_reup_pipeline",
    description:
      "Reup video từ bài viết Threads (6 bước: INGEST -> PROBE -> TRANSCRIBE -> ADAPT_SCRIPT -> DUB_AND_MASTER -> RENDER_EXPORT). Hỗ trợ chỉnh âm lượng âm thanh gốc 0–200% (tự gắn alimiter khi >100%, giữ chuẩn -14 LUFS), xóa logo, che phụ đề gốc, in phụ đề Việt.",
    route: ["POST", "/api/threads/reup"],
    task: true,
    result: (_a, ev) => ({ saved_files: ev.saved_files || [] }),
    parameters: {
      url: str("Link bài viết Threads chứa video (hoặc dùng local_video_path)."),
      local_video_path: str("Đường dẫn video cục bộ nếu đã tải sẵn."),
      voice: P_VOICE,
      original_audio_volume_pct: num(
        "Âm lượng âm thanh gốc 0–200% (0 = tắt hẳn, 1–100 = giảm + ducking, 101–200 = khuếch đại + alimiter -14 LUFS).",
        { default: 20, minimum: 0, maximum: 200 },
      ),
      delogo: P_DELOGO,
      subcover: P_SUBCOVER,
      burn_sub: bool("In cứng phụ đề Việt lên video bằng font trong data/fonts/ (mặc định true)."),
      agy_model: str("Model biên tập lời thoại của Antigravity (id trong list_options.agy_models)."),
      max_duration_sec: num("Giới hạn thời lượng video tối đa tính bằng giây (mặc định 180).", { default: 180, minimum: 1, maximum: 3600 }),
    },
    required: [],
  },
  {
    name: "threads_scrape_post",
    description:
      "Cào nội dung bài viết Threads 2 tầng (Tier 1 SSR + Tier 2 Playwright fallback). Trả ERR_VIDEO_ONLY_POST nếu bài chỉ có video.",
    route: ["POST", "/api/threads/scrape"],
    task: true,
    result: (_a, ev) => ({ logs_tail: (ev.logs || []).slice(-10) }),
    parameters: {
      url: str("Link bài viết Threads công khai."),
      bypass_cache: bool("Bỏ qua cache SQLite để cào mới từ Threads."),
    },
    required: ["url"],
  },
  {
    name: "threads_list_jobs",
    nolog: true,
    description: "Liệt kê các tác vụ Threads (VideoThreads & ReupThreads) gần đây từ SQLite data/openreup.db.",
    parameters: {
      limit: num("Số lượng job tối đa trả về (mặc định 50).", { default: 50, minimum: 1, maximum: 200 }),
    },
    run: async (a) => ({ jobs: threadsRepo.list(a.limit) }),
  },
];
