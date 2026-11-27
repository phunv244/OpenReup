/** Hàm /api/functions của module sources: tải video (Bilibili/YouTube, Douyin), quét kênh, xóa logo, danh sách video nguồn. */
import path from "node:path";
import { BILIBILI_DIR, DATA_DIR } from "../../config.mjs";
import { P_DELOGO, P_PROJECT, bool, num, str } from "../../core/schema.mjs";
import { fileInfo } from "../../lib/util.mjs";

/** Kết quả tác vụ tải: các file script báo SAVED_FILE:::. */
const savedResult = (a, ev) => ({ files: ev.saved_files.map(fileInfo) });

export const SOURCE_FUNCTIONS = [
  {
    name: "download_video",
    description:
      "Tải video Bilibili / YouTube về downloads/bilibili. Chạy nền: trả call_id ngay, dùng get_call để lấy đường dẫn file khi xong. " +
      "Kết quả: files[].rel_path dùng làm rel_path cho dub_video.",
    route: ["POST", "/api/bilibili/download"],
    task: true,
    result: savedResult,
    parameters: {
      url: str("Link video hoặc playlist (bắt đầu bằng http)."),
      quality: str("Độ phân giải.", { enum: ["720p", "best"], default: "best" }),
      playlist: bool("Tải cả playlist / mọi phần (P1, P2...) thay vì chỉ 1 video."),
      playlist_items: str('Chỉ tải một số phần của playlist, ví dụ "1-5" hoặc "1,3,7".'),
      section: str('Chỉ tải 1 đoạn thời gian "HH:MM:SS-HH:MM:SS", ví dụ "00:00:00-01:00:00".'),
      delogo: P_DELOGO,
      perf: str("Mức dùng máy khi phải mã hóa lại (xóa logo).", { enum: ["eco", "balanced", "fast"], default: "balanced" }),
      project_id: P_PROJECT,
    },
    required: ["url"],
  },
  {
    name: "douyin_scan_channel",
    description: "Quét danh sách video của 1 kênh Douyin (cần đã đăng nhập Chrome). Chạy nền; kết quả nằm trong data/videos.json.",
    route: ["POST", "/api/scan"],
    task: true,
    result: () => ({ data_file: path.join(DATA_DIR, "videos.json") }),
    parameters: {
      url: str("Link kênh Douyin. Bỏ trống = kênh mặc định."),
      limit: num("Số video tối đa cần quét. Bỏ trống = tất cả."),
      resume: bool("Quét tiếp từ lần trước thay vì quét lại từ đầu."),
    },
  },
  {
    name: "douyin_download",
    description: "Tải video Douyin đã quét về downloads/. Chạy nền; kết quả files[] là các file đã lưu.",
    route: ["POST", "/api/download"],
    task: true,
    result: savedResult,
    parameters: {
      ids: str("Danh sách aweme_id cách nhau bằng dấu phẩy."),
      episodes: str('Khoảng số tập, ví dụ "1-10".'),
      limit: num("Số video tối đa."),
      project_id: P_PROJECT,
    },
  },
  {
    name: "delogo_video",
    description: "Xóa logo trên 1 video đã tải trong downloads/bilibili (mã hóa lại, ghi đè file). Chạy nền.",
    route: ["POST", "/api/bilibili/delogo"],
    task: true,
    result: (a) => ({ files: [fileInfo(path.join(BILIBILI_DIR, path.basename(String(a.local_file))))] }),
    parameters: {
      local_file: str("Tên file trong downloads/bilibili."),
      delogo: P_DELOGO,
      perf: str("Mức dùng máy.", { enum: ["eco", "balanced", "fast"], default: "balanced" }),
    },
    required: ["local_file"],
  },
  { name: "list_sources", description: "Liệt kê video nguồn đã tải (rel_path, thời lượng, độ phân giải, trạng thái lồng tiếng).", route: ["GET", "/api/sources"], parameters: {} },
];
