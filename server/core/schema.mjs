/** Mảnh JSON Schema dùng chung cho định nghĩa hàm /api/functions của mọi module. */
export const str = (description, extra = {}) => ({ type: "string", description, ...extra });
export const bool = (description) => ({ type: "boolean", description });
export const num = (description, extra = {}) => ({ type: "number", description, ...extra });

export const P_VOICE = str('Giọng đọc: "vieneu:<tên preset>" hoặc "vieneu-clone:<slug>". Lấy danh sách bằng list_options.');
