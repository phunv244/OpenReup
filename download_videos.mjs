#!/usr/bin/env node
/**
 * Download Douyin videos from data/videos.json (fetched via list_channel_web.mjs)
 * Usage:
 *   node download_videos.mjs --limit 5
 *   node download_videos.mjs --episodes 1-10
 *   node download_videos.mjs --ids 7412345678901234567
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// REUP_MEDIA_ROOT / REUP_DATA_DIR: server truyền xuống khi chạy test (thư mục tạm), mặc định là repo.
const MEDIA_ROOT = process.env.REUP_MEDIA_ROOT ? path.resolve(process.env.REUP_MEDIA_ROOT) : __dirname;
const DATA_ROOT = process.env.REUP_DATA_DIR ? path.resolve(process.env.REUP_DATA_DIR) : path.join(__dirname, "data");
const DEFAULT_JSON = path.join(DATA_ROOT, "videos.json");
const DOWNLOAD_DIR = path.join(MEDIA_ROOT, "downloads");

function parseArgs(argv) {
  const args = {
    json: DEFAULT_JSON,
    outDir: DOWNLOAD_DIR,
    limit: 0,
    episodes: "",
    ids: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" && argv[i + 1]) args.json = argv[++i];
    else if (a === "--out" && argv[i + 1]) args.outDir = argv[++i];
    else if (a === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === "--episodes" && argv[i + 1]) args.episodes = argv[++i];
    else if (a === "--ids" && argv[i + 1]) args.ids = argv[++i];
  }
  return args;
}

function sanitizeFilename(s) {
  return (s || "video")
    .replace(/[\\/:*?"<>|#\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Referer: "https://www.douyin.com/",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  // Ghi thẳng xuống đĩa (không giữ cả video trong RAM) qua file .part: tải dở không bị coi là đã xong.
  const partPath = destPath + ".part";
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partPath));
  fs.renameSync(partPath, destPath);
  return fs.statSync(destPath).size;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.json)) {
    console.error(`Không tìm thấy ${args.json}. Hãy chạy list_channel_web.mjs trước.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(args.json, "utf8"));
  let videos = (data.videos || []).filter((v) => v.download_url);

  if (args.ids) {
    const idSet = new Set(args.ids.split(",").map((x) => x.trim()));
    videos = videos.filter((v) => idSet.has(String(v.aweme_id)));
  }

  if (args.episodes) {
    const m = args.episodes.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const start = Number(m[1]);
      const end = Number(m[2]);
      videos = videos
        .filter((v) => v.episode_num !== null && v.episode_num >= start && v.episode_num <= end)
        .sort((a, b) => a.episode_num - b.episode_num);
    } else if (/^\d+$/.test(args.episodes)) {
      const target = Number(args.episodes);
      videos = videos.filter((v) => v.episode_num === target);
    }
  }

  if (args.limit > 0) {
    videos = videos.slice(0, args.limit);
  }

  if (videos.length === 0) {
    console.log("Không có video nào khớp điều kiện tải (hoặc chưa có download_url từ web).");
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  console.log(`Bắt đầu tải ${videos.length} video vào ${args.outDir}...`);

  let ok = 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const epPrefix = v.episode_num != null ? `Ep${String(v.episode_num).padStart(3, "0")}_` : "";
    const filename = `${epPrefix}${v.aweme_id}_${sanitizeFilename(v.title)}.mp4`;
    const dest = path.join(args.outDir, filename);

    if (fs.existsSync(dest) && fs.statSync(dest).size > 50_000) {
      console.log(`[${i + 1}/${videos.length}] Đã có sẵn: ${filename}`);
      console.log(`SAVED_FILE:::${dest}`);
      ok++;
      continue;
    }

    try {
      const bytes = await downloadFile(v.download_url, dest);
      const mb = (bytes / (1024 * 1024)).toFixed(2);
      console.log(`[${i + 1}/${videos.length}] OK (${mb} MB): ${filename}`);
      console.log(`SAVED_FILE:::${dest}`); // server.mjs dựa vào dòng này để gán video vào dự án
      ok++;
    } catch (err) {
      console.error(`[${i + 1}/${videos.length}] Lỗi tải ${v.aweme_id}: ${err.message}`);
    }
  }
  console.log(`Hoàn tất: ${ok}/${videos.length} video.`);
}

main();
