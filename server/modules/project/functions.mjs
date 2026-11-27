/** Hàm /api/functions của module project (MausBot gọi qua đây; định dạng như server/routes/functions.mjs). */
import { P_VOICE, str } from "../../core/schema.mjs";

export const PROJECT_FUNCTIONS = [
  {
    name: "list_projects",
    description: "Liệt kê đầy đủ các dự án Reup: giọng đọc dùng chung, nhân vật (tên gốc/Việt, xưng hô, tính cách), thuật ngữ, mạch truyện, danh sách bản lồng tiếng đã gán; video_count = số video nguồn (mỗi video đếm 1 lần dù lồng tiếng nhiều lần), dubbed_count = số video đã lồng tiếng, pending_count = số video chưa lồng tiếng.",
    route: ["GET", "/api/projects"],
    parameters: {},
  },
  {
    name: "create_project",
    description: "Tạo dự án Reup mới để nhóm nhiều video cùng bộ truyện, dùng chung nhân vật / thuật ngữ / mạch truyện khi dịch.",
    route: ["POST", "/api/projects"],
    parameters: {
      name: str("Tên dự án."),
      type: str("Thể loại.", { default: "Truyện / Hoạt hình" }),
      style: str("Phong cách dịch & giọng văn mong muốn."),
      synopsis: str("Cốt truyện chung, càng chi tiết AI dịch càng đúng mạch."),
      voice: P_VOICE,
    },
    required: ["name"],
  },
  {
    name: "update_project",
    description:
      "Sửa thông tin dự án Reup: ngữ cảnh chung, giọng đọc dùng chung cho mọi nhân vật (chọn từ list_options.voices ở Tài nguyên), danh sách nhân vật và thuật ngữ.",
    route: ["POST", "/api/projects/save"],
    parameters: {
      id: str("Mã dự án (id trong list_options.projects)."),
      name: str("Tên dự án."),
      type: str("Thể loại."),
      style: str("Phong cách dịch & giọng văn."),
      synopsis: str("Cốt truyện chung."),
      voice: P_VOICE,
      characters: {
        type: "array",
        description: "Toàn bộ danh sách nhân vật (ghi đè danh sách cũ). Mọi nhân vật dùng chung giọng đọc của dự án (field voice trên).",
        items: {
          type: "object",
          properties: {
            zh: str("Tên gốc."), vi: str("Tên Việt."), pronouns: str("Xưng hô."), role: str("Vai trò."),
            personality: str("Tính cách, giọng điệu."),
          },
        },
      },
      glossary: { type: "array", description: "Toàn bộ từ điển thuật ngữ (ghi đè danh sách cũ).", items: { type: "object", properties: { zh: str("Từ gốc."), vi: str("Dịch tiếng Việt.") } } },
    },
    required: ["id"],
  },
  { name: "delete_project", description: "Xóa 1 dự án Reup (chỉ mất ngữ cảnh AI; các file video vẫn được giữ, trở về trạng thái chưa gán dự án).", route: ["POST", "/api/projects/delete"], parameters: { id: str("Mã dự án (id trong list_options.projects).") }, required: ["id"] },
];
