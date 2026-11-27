/** Hàm /api/functions của module resources: giọng clone, mô hình nhận diện, font phụ đề. */
import { P_PROJECT, num, str } from "../../core/schema.mjs";

/**
 * list_options gom giá trị hợp lệ của nhiều module qua HTTP (get = GET nội bộ app.inject), không import module khác.
 * Vì đọc /api/agy-models (ai) và /api/projects (project), resources khai deps "ai", "project": thiếu thì lỗi lúc khởi động.
 */
const LIST_OPTIONS = {
  name: "list_options",
  description: "Các giá trị hợp lệ cho tham số: giọng đọc, mô hình nhận diện, model dịch, dự án, font phụ đề.",
  parameters: {},
  run: async (a, get) => {
    const [voices, asr, agy, projects, fonts] = await Promise.all(["/api/voices", "/api/asr-models", "/api/agy-models", "/api/projects", "/api/fonts"].map(get));
    return {
      voices: [...(voices.presets || []), ...(voices.clones || [])].map((v) => ({ id: v.id, name: v.name, gender: v.gender, kind: v.kind || "vieneu" })),
      asr_models: (asr.models || []).map((m) => ({ id: m.id, name: m.name, installed: m.installed, hw: m.hw })),
      agy_models: (agy.models || []).map((m) => ({ id: m.id, name: m.name })),
      projects: (projects.projects || []).map((p) => ({ id: p.id, name: p.name, video_count: p.video_count, dubbed_count: p.dubbed_count, pending_count: p.pending_count })),
      fonts: (fonts.fonts || []).map((f) => ({ family: f.family, vi: f.vi })),
      delogo: ["none", "top-right", "top-left", "both-top", "x,y,w,h"],
      quality: ["720p", "best"],
      perf: ["eco", "balanced", "fast"],
    };
  },
};

export const RESOURCE_FUNCTIONS = [
  {
    name: "create_voice",
    description: "Thêm giọng clone mới vào Tài nguyên (dùng chung mọi dự án) từ 1 video đã tải (rel_path) hoặc 1 link audio/video.",
    route: ["POST", "/api/voices/create"],
    parameters: {
      name: str("Tên hiển thị của giọng."),
      rel_path: str('Video nguồn đã tải, ví dụ "downloads/bilibili/abc.mp4" (lấy từ list_sources). Dùng 1 trong 2: rel_path hoặc url.'),
      url: str("Link audio/video trực tiếp để lấy mẫu giọng. Dùng 1 trong 2: rel_path hoặc url."),
      gender: str("Giới tính giọng.", { enum: ["male", "female"] }),
      start: num("Giây bắt đầu đoạn mẫu trong nguồn. Bỏ trống = máy tự chọn đoạn rõ giọng nhất."),
      end: num("Giây kết thúc đoạn mẫu (nên dài 5-15s)."),
      project_id: P_PROJECT,
    },
    required: ["name"],
  },
  { name: "update_voice", description: "Đổi tên / giới tính của 1 giọng clone đã có.", route: ["POST", "/api/voices/update"], parameters: { slug: str("Mã giọng (phần sau \"vieneu-clone:\" trong id)."), name: str("Tên mới."), gender: str("Giới tính.", { enum: ["male", "female", ""] }) }, required: ["slug"] },
  { name: "delete_voice", description: "Xóa 1 giọng clone khỏi Tài nguyên (gỡ khỏi mọi dự án đang dùng).", route: ["POST", "/api/voices/delete"], parameters: { slug: str("Mã giọng (phần sau \"vieneu-clone:\" trong id).") }, required: ["slug"] },
  {
    name: "download_asr_model",
    description: "Tải 1 mô hình nhận diện giọng nói (ASR) về máy để dùng cho dub_video. Chạy nền.",
    route: ["POST", "/api/asr-models/download"],
    task: true,
    result: () => ({}),
    parameters: { id: str("Mã mô hình (id trong list_options.asr_models).") },
    required: ["id"],
  },
  { name: "delete_font", description: "Xóa 1 font chữ phụ đề đã tải lên Tài nguyên (video đang dùng font này quay về font mặc định ở lần xuất lại sau).", route: ["POST", "/api/fonts/delete"], parameters: { id: str("Mã font.") }, required: ["id"] },
  LIST_OPTIONS,
];
