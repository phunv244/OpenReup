/**
 * Thông tin media + ảnh xem trước (không bắt trình duyệt mở file nhiều GB).
 * Khóa cache (media_cache.json, tên ảnh trong thumbs/) theo rel_path "downloads/..." + size + mtime, không theo đường
 * dẫn thật: chuyển file sang data/videos/<key>/source/ (rename giữ size/mtime) thì cache vẫn dùng được.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MEDIA_CACHE_JSON, THUMBS_DIR } from "../config.mjs";
import { execFileP, readJson, writeJson } from "./util.mjs";

let mediaCache = null;
let mediaCacheDirty = false;

export const mediaKey = (rel, st) => `${rel}|${st.size}|${Math.round(st.mtimeMs)}`;

export async function probeMedia(rel, fullPath, st) {
  mediaCache ??= readJson(MEDIA_CACHE_JSON, {});
  const key = mediaKey(rel, st);
  if (mediaCache[key]) return mediaCache[key];
  let info = { duration_sec: 0, resolution: "" };
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration", "-of", "json", fullPath,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    info = {
      duration_sec: Math.round(Number(j.format?.duration || 0)),
      resolution: s.width && s.height ? `${s.width}x${s.height}` : "",
    };
  } catch {}
  mediaCache[key] = info;
  mediaCacheDirty = true;
  return info;
}

export function flushMediaCache(liveKeys) {
  if (!mediaCacheDirty) return;
  for (const k of Object.keys(mediaCache)) if (!liveKeys.has(k)) delete mediaCache[k];
  writeJson(MEDIA_CACHE_JSON, mediaCache, 0);
  mediaCacheDirty = false;
}

let thumbQueue = Promise.resolve();

export function ensureThumb(rel, fullPath, st) {
  const key = crypto.createHash("sha1").update(mediaKey(rel, st)).digest("hex");
  const out = path.join(THUMBS_DIR, `${key}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  // Xếp hàng lần lượt: mở trang có 50 video cũng chỉ chạy 1 ffmpeg tại 1 thời điểm.
  const job = thumbQueue.then(async () => {
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const tmp = `${out}.tmp.jpg`;
    for (const ss of ["8", "0"]) {
      try {
        await execFileP("ffmpeg", ["-v", "error", "-y", "-ss", ss, "-i", fullPath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", tmp]);
        if (fs.existsSync(tmp)) {
          fs.renameSync(tmp, out);
          return out;
        }
      } catch {}
    }
    return "";
  });
  thumbQueue = job.catch(() => "");
  return job;
}

/** Khung hình gốc (giây đầu) để khoanh vùng logo, giữ nguyên độ phân giải. */
export async function extractFrame(full) {
  for (const ss of ["1", "0"]) {
    try {
      const { stdout } = await execFileP(
        "ffmpeg",
        ["-v", "error", "-ss", ss, "-i", full, "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
        { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30000 }
      );
      if (stdout.length) return stdout;
    } catch {}
  }
  return null;
}
