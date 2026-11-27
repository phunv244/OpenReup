/** Định dạng hiển thị + hằng số dùng chung. */

export const TASK_NAMES: Record<string, string> = {
  scan_web: "Quét kênh Douyin",
  download: "Tải video Douyin",
  bilibili_download: "Tải video Bilibili / YouTube",
  bilibili_delogo: "Xóa logo",
  dub_video: "Dịch & lồng tiếng",
  dub_rerender: "Xuất lại bản lồng tiếng",
  asr_download: "Tải mô hình nhận diện",
  login_chrome: "Đăng nhập Chrome",
  threads_video: "Threads · Video từ Chữ/Ảnh",
  threads_reup: "Threads · Reup Video",
  threads_scrape: "Threads · Cào bài viết",
};
export const taskName = (type: string) => TASK_NAMES[type] || type || "Tiến trình";

export const DUB_STAGES = ["Nhận diện", "Dịch", "Giọng đọc", "Xuất video", "Ghép tiếng"];

export const isRegion = (s?: string) => /^\d+,\d+,\d+,\d+$/.test(String(s || ""));

export const PERF_OPTIONS: [string, string][] = [
  ["balanced", "Cân bằng — 50% CPU"],
  ["eco", "Mát máy — 30% CPU"],
  ["fast", "Tối đa — nhanh nhất"],
];

export function fmtDur(sec?: number) {
  sec = Math.round(Number(sec || 0));
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Thời lượng dạng chữ cho số liệu tổng: "92 giờ 15 phút". */
export function fmtHours(sec: number) {
  sec = Math.round(Number(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} giờ ${m} phút`;
  if (h) return `${h} giờ`;
  return `${Math.max(sec ? 1 : 0, m)} phút`;
}

export function fmtEta(sec: number | null | undefined) {
  if (sec == null) return "";
  return sec < 60 ? "còn dưới 1 phút" : `còn ~${fmtHours(sec)}`;
}

export function fmtSize(mb?: number) {
  mb = Number(mb || 0);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export const fmtClock = (ms: number) =>
  ms ? new Date(ms).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "";

/** "downloads/bilibili/x.mp4" -> "x.mp4" */
export const baseName = (p: string) => String(p || "").split("/").pop() || "";

/** Mã thoát -> trạng thái: ok / dừng / lỗi */
export const exitTone = (code: number | null) => (code === 0 ? "ok" : code === 130 || code == null ? "stopped" : "err");

/** Đường dẫn trang trong dự án */
export const projHref = (pid: string, sub: string, extra = "") => `/project/${sub}/?id=${encodeURIComponent(pid)}${extra}`;
