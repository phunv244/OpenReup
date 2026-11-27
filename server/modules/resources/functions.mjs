/** Hàm /api/functions của module resources: giọng clone, mô hình nhận diện, font phụ đề. */
import { P_PROJECT, num, str } from "../../core/schema.mjs";

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
];
