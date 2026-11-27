/** Mảnh JSON Schema dùng chung cho định nghĩa hàm /api/functions của mọi module. */
export const str = (description, extra = {}) => ({ type: "string", description, ...extra });
export const bool = (description) => ({ type: "boolean", description });
export const num = (description, extra = {}) => ({ type: "number", description, ...extra });

export const P_VOICE = str('Giọng đọc: "vieneu:<tên preset>" hoặc "vieneu-clone:<slug>". Lấy danh sách bằng list_options.');

export const P_DELOGO = str('Xóa logo: "none" | "top-right" | "top-left" | "both-top" | vùng pixel "x,y,w,h" trên khung hình gốc.');
export const P_SUBCOVER = str('Xóa phụ đề gốc tiếng Trung: "none" hoặc vùng pixel "x,y,w,h" bao quanh dòng phụ đề.');
export const P_PROJECT = str("Mã dự án truyện (id trong list_options.projects) để dùng chung nhân vật / thuật ngữ. Bỏ trống = không gắn dự án.");
export const P_SUB_STYLE = {
  type: "object",
  description: "Kiểu phụ đề Việt in cứng. Bỏ trống = mặc định (chữ trắng, nền đen 87%).",
  properties: {
    font: str("Tên font (family) trong list_options.fonts."),
    size_pct: num("Cỡ chữ, % so với cỡ tự tính.", { minimum: 40, maximum: 250 }),
    bold: bool("Chữ đậm."),
    color: str("Màu chữ #RRGGBB."),
    bg: str("Màu nền sau chữ #RRGGBB."),
    bg_opacity: num("Độ đặc của nền, 0 = không nền.", { minimum: 0, maximum: 100 }),
    outline: str("Màu viền chữ #RRGGBB."),
    outline_width: num("Độ dày viền chữ, 0 = không viền."),
  },
  additionalProperties: false,
};
