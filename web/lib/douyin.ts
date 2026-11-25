/** Chuẩn hóa danh sách video Douyin (phần / tập / trạng thái). */
import { DouyinVideo } from "./api";

export const DEFAULT_CHANNEL_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";
const P2_START_TS = Math.floor(Date.parse("2026-02-16T00:00:00Z") / 1000);

export const SEASON_LABEL: Record<string, string> = { p1: "Phần 1", p2: "Phần 2", other: "Khác" };
export const STATUS_LABEL: Record<string, string> = { pending: "Chưa reup", downloaded: "Đã tải", reupped: "Đã reup" };
export const STATUS_TONE: Record<string, string> = { pending: "gray", downloaded: "green", reupped: "amber" };

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

export function cnToInt(text: string) {
  let total = 0;
  let cur = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) cur = CN_DIGITS[ch];
    else if (ch in CN_UNITS) {
      total += (cur || 1) * CN_UNITS[ch];
      cur = 0;
    } else return null;
  }
  return total + cur || null;
}

export function normalizeVideo(v: Omit<DouyinVideo, "_season" | "_status">): DouyinVideo {
  const out = { ...v } as DouyinVideo;
  // Sửa các tiêu đề thiếu chữ "集" (vd: 第一百零三：...)
  if (out.episode_num == null) {
    const m = (out.title || "").match(/^\s*(?:【[^】]*】)?\s*第([零〇一二两三四五六七八九十百千]+)[：:]/);
    const n = m && cnToInt(m[1]);
    if (n) {
      out.episode_num = n;
      out.episode_label = String(n);
    }
  }
  out._season = out.episode_num == null ? "other" : (out.publish_time || 0) >= P2_START_TS ? "p2" : "p1";
  out._status = out.reup_status === "reupped" ? "reupped" : out.local_file || out.reup_status === "downloaded" ? "downloaded" : "pending";
  return out;
}

export const videoKey = (v: DouyinVideo) => v.aweme_id || `${v.title}|${v.publish_date || ""}`;

export function epText(v: DouyinVideo) {
  if (!v.episode_label) return v._season === "other" ? "Video phụ" : "—";
  return `${SEASON_LABEL[v._season] || ""} · Tập ${v.episode_label}`;
}

export const dateOnly = (s?: string) => (s || "").slice(0, 10) || "—";
