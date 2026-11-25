/** Kiểu phụ đề mặc định cho form "Tùy chỉnh" — khớp STYLE_DEFAULTS trong subtitles.py. */
import { SubStyle } from "./api";

export const DEFAULT_FONT = "DejaVu Sans";
export const SUB_DEFAULT: SubStyle = {
  font: DEFAULT_FONT,
  size_pct: 100,
  bold: true,
  color: "#FFFFFF",
  bg: "#000000",
  bg_opacity: 87,
  outline: "#000000",
  outline_width: 0,
};

/** Điểm xuất phát khi bấm "Tùy chỉnh": giống hệt kiểu mặc định đang thấy (có vùng che phụ đề gốc thì không nền, có viền mỏng). */
export function startingStyle(coverOn: boolean): SubStyle {
  return coverOn ? { ...SUB_DEFAULT, bg_opacity: 0, outline_width: 1.6 } : { ...SUB_DEFAULT };
}

export const isRegionValue = (s: string) => /^\d+,\d+,\d+,\d+$/.test(s);
