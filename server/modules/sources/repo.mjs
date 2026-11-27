/** Đọc/ghi dữ liệu của module sources: data/videos.json (Douyin), data/bilibili.json, file video trong downloads/, video nguồn → dự án. */
import fs from "node:fs";
import path from "node:path";
import { BILIBILI_DIR, BILIBILI_JSON, DATA_JSON, DEFAULT_CHANNEL_URL, DOWNLOADS_DIR } from "../../config.mjs";
import { readVideoProjects, setVideoProject } from "../../lib/store.mjs";
import { readJson, writeJson } from "../../lib/util.mjs";

const EMPTY_DOUYIN = () => ({
  source: "none",
  updated_at: "",
  channel_meta: { channel_name: "楚新钓", douyin_id: "76602931608", channel_url: DEFAULT_CHANNEL_URL, total_works: "580" },
  total_collected: 0,
  videos: [],
});

export const sourceRepo = {
  /** data/videos.json + local_file của video đã tải (khớp theo aweme_id trong tên file). */
  readDouyin() {
    if (!fs.existsSync(DATA_JSON)) return EMPTY_DOUYIN();
    const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
    const downloaded = fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".mp4")) : [];
    for (const v of data.videos || []) v.local_file = (v.aweme_id && downloaded.find((f) => f.includes(String(v.aweme_id)))) || "";
    return data;
  },
  /** data/videos.json gốc (null nếu chưa quét) / ghi lại. */
  readDouyinRaw: () => (fs.existsSync(DATA_JSON) ? JSON.parse(fs.readFileSync(DATA_JSON, "utf8")) : null),
  writeDouyin: (data) => writeJson(DATA_JSON, data),

  /** Mục trong data/bilibili.json còn file trong downloads/bilibili. */
  listBilibili: () => (readJson(BILIBILI_JSON, {}).videos || []).filter((v) => v.local_file && fs.existsSync(path.join(BILIBILI_DIR, v.local_file))),
  removeFromBiliIndex(fname) {
    if (!fs.existsSync(BILIBILI_JSON)) return;
    const d = readJson(BILIBILI_JSON, { videos: [] });
    d.videos = (d.videos || []).filter((v) => v.local_file !== fname);
    d.total = d.videos.length;
    d.updated_at = new Date().toISOString().slice(0, 19);
    writeJson(BILIBILI_JSON, d);
  },

  /** File .mp4 (không phải file tạm xóa logo) của 1 thư mục: [{ name, full, st }]. */
  listMp4(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".mp4") && !f.includes(".delogo_tmp"))
      .map((f) => ({ name: f, full: path.join(dir, f), st: fs.statSync(path.join(dir, f)) }))
      .filter((x) => x.st.isFile());
  },
  exists: (full) => fs.existsSync(full),
  isFile: (full) => fs.existsSync(full) && fs.statSync(full).isFile(),
  /** Xóa file video + file .info.json đi kèm. */
  removeVideo(full) {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) fs.unlinkSync(full);
    fs.rmSync(full.replace(/\.mp4$/i, ".info.json"), { force: true });
  },

  owners: readVideoProjects,
  setOwner: setVideoProject,
};
