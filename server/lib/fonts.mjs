/** Kiểm tra kiểu phụ đề dùng chung (module dub khi xuất, module resources khi xem trước). Dữ liệu font: server/modules/resources/. */

// Tên họ font đi vào file ASS: chặn ký tự phá cú pháp (dấu phẩy, ngoặc nhọn, xuống dòng...).
export const validFontFamily = (v) => /^[\p{L}\p{N} ._+()'-]{1,80}$/u.test(String(v));

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
