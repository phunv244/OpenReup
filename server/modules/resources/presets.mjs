/** Giọng VieNeu có sẵn (không cần clone). */
const P = (kind, id, name, gender, desc) => ({ id, kind, name, gender, desc });
export const PRESET_VOICES = [
  ...[
    ["Thiện Minh", "male", "Bắc · kể chuyện"], ["Thiền Tâm Đức", "male", "Bắc · kể chuyện"], ["Hải Đăng", "male", "Bắc · tự nhiên"],
    ["Adam bựa", "male", "Bắc · tự nhiên"], ["Quang Sơn", "male", "Trung · tự nhiên"], ["Minh Đức", "male", "Bắc · tin tức"],
    ["Phạm Tuyên", "male", "Bắc · tự nhiên"], ["Thái Sơn", "male", "Nam · kể chuyện"], ["Xuân Vĩnh", "male", "Bắc · tự nhiên"],
    ["Thanh Bình", "male", "Bắc · kể chuyện"], ["Minh Triết", "male", "Nam · tin tức"], ["Đức Trí", "male", "Nam · đọc truyện"],
    ["Adam", "male", "Nam · tự nhiên"], ["Quốc Tuấn", "male", "Bắc · tự nhiên"],
    ["Ngọc Huyền", "female", "Bắc · tự nhiên"], ["Trúc Ly", "female", "Bắc · tự nhiên"], ["Quỳnh Anh", "female", "Bắc · đọc truyện"],
    ["Mai Anh", "female", "Bắc · tin tức"], ["Thùy Dung", "female", "Nam · tin tức"], ["Ngọc Trân", "female", "Trung · tự nhiên"],
    ["Ngọc Linh", "female", "Bắc · kể chuyện"], ["Đoan Trang", "female", "Bắc · tự nhiên"], ["Thục Đoan", "female", "Nam · kể chuyện"],
    ["Mỹ Duyên", "female", "Nam · đọc truyện"], ["Kim Thanh", "female", "Nam · đọc truyện"],
  ].map(([name, gender, desc]) => P("vieneu", `vieneu:${name}`, name, gender, desc)),
];
