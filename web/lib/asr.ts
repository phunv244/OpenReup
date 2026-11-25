/** Mô hình nhận diện tiếng Trung: số đo tham khảo + nhãn cho ô chọn. Danh mục gốc ở asr.py (CATALOG). */
import { AsrInfo } from "./api";

// Đo trên máy Ryzen 5 2400G (CPU), video 8 phút có ~291 giây lời thoại.
export const ASR_BENCH: Record<string, { sec: number; miss: number; note: string }> = {
  base: { sec: 145, miss: 21, note: "nghe nhầm nhiều" },
  small: { sec: 464, miss: 22, note: "đúng chữ hơn, có lúc ảo giác lặp chữ khi nhạc to" },
  "sensevoice-small": { sec: 31, miss: 4, note: "câu liền mạch, có dấu câu" },
  "paraformer-zh": { sec: 24, miss: 2, note: "không có dấu câu, câu hay bị cắt giữa từ" },
};
export const ASR_RECOMMENDED = "sensevoice-small";

/** Model mặc định khi mở hộp thoại: model đã dùng > model khuyên dùng > model đầu tiên đã tải. */
export function pickModel(asr: AsrInfo, selected = "") {
  const m = asr.models;
  return (
    m.find((x) => x.id === selected && x.installed)?.id ||
    m.find((x) => x.id === ASR_RECOMMENDED && x.installed)?.id ||
    m.find((x) => x.installed)?.id ||
    ""
  );
}

export function asrTag(asr: AsrInfo, id: string) {
  const m = asr.models.find((x) => x.id === id);
  if (!m) return "";
  if (!m.installed) return " — chưa tải";
  if (m.id === ASR_RECOMMENDED) return " — khuyên dùng";
  return m.hw === "gpu" && !asr.gpu.cuda ? " — chậm nếu không có GPU" : "";
}
