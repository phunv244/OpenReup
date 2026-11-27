/** Kiểu dữ liệu và hàm tính toán thuần của timeline (không phụ thuộc React). */
export type Seg = { id: number; start: number; end: number; zh: string; vi: string; speaker: string };
export type Outline = { total: number; truncated: boolean; items: Seg[] };
export type Edge = "l" | "r";
export type Span = { start: number; end: number };

export const spkIndex = (k: string) => Number(String(k).replace(/\D/g, "")) || 1;
export const MIN_PX_SEC = 4;
export const MAX_PX_SEC = 240;
/** Vẽ thêm 1 khoảng đệm ngoài vùng nhìn thấy để cuộn nhanh không thấy khoảng trống. */
export const OVERSCAN_PX = 600;

/** Chỉ số câu đầu tiên có end >= t (items đã sắp theo start, các câu không chồng nhau). */
export function firstEndingAfter(items: Seg[], t: number) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].end < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bước chia thước theo mức phóng: càng phóng to thì vạch càng dày. */
export const tickStep = (pxPerSec: number) => (pxPerSec > 60 ? 5 : pxPerSec > 20 ? 10 : pxPerSec > 8 ? 30 : 60);
