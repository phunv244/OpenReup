#!/usr/bin/env node
/**
 * Bilibili / YouTube Downloader + Standalone/Integrated FFmpeg Delogo
 * Safe for ultra-long (e.g. 90-hour) videos:
 *  - Time-range slicing (--section "00:00:00-01:00:00") via yt-dlp --download-sections
 *  - Multi-part range selection (--playlist-items "1-5")
 *  - Standalone post-download delogo (--delogo-file <filename> --delogo top-right)
 *  - Auto GPU detection (NVENC if driver active) + CPU thread/nice throttling (--perf eco|balanced|fast)
 *  - Network resume/retry (--continue --retries 20 --fragment-retries 20)
 *  - Disk free-space guard + bounded memory line parser
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "downloads", "bilibili");
const META_JSON = path.join(__dirname, "data", "bilibili.json");
const MIN_FREE_GB = 5;

function parseArgs(argv) {
  const args = {
    url: "",
    playlist: false,
    playlistItems: "",
    section: "",
    outDir: OUT_DIR,
    quality: "best",
    delogo: "top-right",
    delogoFile: "",
    perf: "balanced", // eco | balanced | fast
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) args.url = argv[++i];
    else if (a === "--playlist") args.playlist = true;
    else if (a === "--playlist-items" && argv[i + 1]) args.playlistItems = argv[++i];
    else if (a === "--section" && argv[i + 1]) args.section = argv[++i];
    else if (a === "--out" && argv[i + 1]) args.outDir = argv[++i];
    else if (a === "--quality" && argv[i + 1]) args.quality = argv[++i];
    else if (a === "--delogo" && argv[i + 1]) args.delogo = argv[++i];
    else if (a === "--delogo-file" && argv[i + 1]) args.delogoFile = argv[++i];
    else if (a === "--perf" && argv[i + 1]) args.perf = argv[++i];
    else if (!a.startsWith("--") && !args.url) args.url = a;
  }
  return args;
}

function getFreeDiskGb(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return Number(((st.bavail * st.bsize) / 1024 ** 3).toFixed(2));
  } catch {
    return 999;
  }
}

function assertDiskSpace(dir, requiredGb = MIN_FREE_GB) {
  const freeGb = getFreeDiskGb(dir);
  if (freeGb < requiredGb) {
    throw new Error(
      `Ổ cứng chỉ còn trống ${freeGb} GB (cần tối thiểu ${requiredGb.toFixed(1)} GB để tránh đầy ổ). Hãy xóa bớt file cũ hoặc tải cắt khúc nhỏ hơn.`
    );
  }
  console.log(`[Disk] Ổ cứng còn trống: ${freeGb} GB (an toàn).`);
}

function loadHistory() {
  if (!fs.existsSync(META_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(META_JSON, "utf8")).videos || [];
  } catch {
    return [];
  }
}

function saveHistory(videos) {
  fs.mkdirSync(path.dirname(META_JSON), { recursive: true });
  fs.writeFileSync(
    META_JSON,
    JSON.stringify(
      {
        updated_at: new Date().toISOString().slice(0, 19),
        total: videos.length,
        videos,
      },
      null,
      2
    ),
    "utf8"
  );
}

/**
 * Streaming command runner that does NOT accumulate unlimited stdout into RAM.
 * Only retains lines starting with `SAVED_FILE:::`.
 */
function runStreamingCmd(cmd, args, { niceLevel = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const finalCmd = niceLevel > 0 ? "nice" : cmd;
    const finalArgs = niceLevel > 0 ? ["-n", String(niceLevel), cmd, ...args] : args;

    const proc = spawn(finalCmd, finalArgs, { cwd: __dirname });
    const savedFiles = [];
    let partial = "";

    proc.stdout.on("data", (buf) => {
      const chunk = buf.toString("utf8");
      process.stdout.write(chunk);
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("SAVED_FILE:::")) {
          savedFiles.push(line.slice("SAVED_FILE:::".length).trim());
        }
      }
    });
    proc.stderr.on("data", (buf) => {
      process.stderr.write(buf.toString("utf8"));
    });
    proc.on("close", (code) => {
      if (partial.startsWith("SAVED_FILE:::")) {
        savedFiles.push(partial.slice("SAVED_FILE:::".length).trim());
      }
      if (code === 0) resolve({ savedFiles });
      else reject(new Error(`${cmd} thoát với mã lỗi ${code}`));
    });
  });
}

function probeVideo(mp4Path) {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        mp4Path,
      ],
      { encoding: "utf8" }
    );
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    const dur = Number(j.format?.duration || 0);
    return {
      w: Number(s.width || 1920),
      h: Number(s.height || 1080),
      duration: dur ? Math.round(dur) : 0,
    };
  } catch {
    return { w: 1920, h: 1080, duration: 0 };
  }
}

let cachedNvencAvailable = null;
function hasWorkingNvenc() {
  if (cachedNvencAvailable !== null) return cachedNvencAvailable;
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=640x360:rate=10", "-pix_fmt", "yuv420p", "-c:v", "h264_nvenc", "-f", "null", "-"],
      { stdio: "ignore", timeout: 5000 }
    );
    cachedNvencAvailable = true;
  } catch {
    cachedNvencAvailable = false;
  }
  return cachedNvencAvailable;
}

function buildDelogoFilter(mode, w, h) {
  if (!mode || mode === "none") return "";

  if (/^\d+,\d+,\d+,\d+$/.test(mode)) {
    const [x, y, bw, bh] = mode.split(",").map(Number);
    return `delogo=x=${x}:y=${y}:w=${bw}:h=${bh}:show=0`;
  }

  const isPortrait = h > w;
  const topY = Math.max(2, Math.round(h * 0.015));
  const boxH = Math.round(h * (isPortrait ? 0.042 : 0.068));
  const boxW = Math.round(w * (isPortrait ? 0.39 : 0.25));
  const leftX = Math.max(2, Math.round(w * 0.02));
  const rightX = Math.max(2, w - boxW - Math.round(w * 0.015));

  if (mode === "top-left") return `delogo=x=${leftX}:y=${topY}:w=${boxW}:h=${boxH}:show=0`;
  if (mode === "top-right") return `delogo=x=${rightX}:y=${topY}:w=${boxW}:h=${boxH}:show=0`;
  if (mode === "both-top") {
    return `delogo=x=${leftX}:y=${topY}:w=${boxW}:h=${boxH}:show=0,delogo=x=${rightX}:y=${topY}:w=${boxW}:h=${boxH}:show=0`;
  }
  return "";
}

async function removeLogoInPlace(mp4Path, mode, perf = "balanced") {
  const stat = fs.statSync(mp4Path);
  const fileGb = stat.size / 1024 ** 3;
  assertDiskSpace(path.dirname(mp4Path), Math.max(MIN_FREE_GB, fileGb * 1.4));

  const { w, h } = probeVideo(mp4Path);
  const vf = buildDelogoFilter(mode, w, h);
  if (!vf) return;

  const cpuCount = Math.max(2, os.cpus().length);
  const threads =
    perf === "eco"
      ? Math.max(2, Math.floor(cpuCount * 0.33))
      : perf === "fast"
        ? 0
        : Math.max(2, Math.floor(cpuCount * 0.5));
  const niceLevel = perf === "eco" ? 19 : perf === "balanced" ? 12 : 0;

  const useNvenc = hasWorkingNvenc();
  const encoderArgs = useNvenc
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "22"]
    : [
        "-c:v",
        "libx264",
        "-preset",
        perf === "eco" ? "superfast" : "veryfast",
        "-crf",
        "20",
        ...(threads > 0 ? ["-threads", String(threads)] : []),
      ];

  const tmpPath = mp4Path.replace(/\.mp4$/i, ".delogo_tmp.mp4");
  const encDesc = useNvenc
    ? "GPU NVIDIA NVENC"
    : `CPU libx264 (${threads || cpuCount}/${cpuCount} luồng, nice=${niceLevel})`;
  console.log(`[Delogo] Đang xóa logo (${mode}) bằng ${encDesc} trên ${path.basename(mp4Path)} (${w}x${h})...`);

  try {
    await runStreamingCmd(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "warning",
        "-stats",
        "-i",
        mp4Path,
        "-vf",
        vf,
        ...encoderArgs,
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        tmpPath,
      ],
      { niceLevel }
    );
    fs.renameSync(tmpPath, mp4Path);
    console.log(`[Delogo] Xóa logo hoàn tất!`);
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw err;
  }
}

async function runStandaloneDelogo(args) {
  const safeName = path.basename(args.delogoFile);
  const mp4Path = path.join(args.outDir, safeName);
  if (!fs.existsSync(mp4Path)) {
    throw new Error(`Không tìm thấy file: ${safeName}`);
  }
  if (!args.delogo || args.delogo === "none") {
    throw new Error("Vui lòng chọn vị trí logo cần xóa (top-right, top-left, both-top).");
  }

  await removeLogoInPlace(mp4Path, args.delogo, args.perf);

  const stat = fs.statSync(mp4Path);
  const history = loadHistory();
  let found = false;
  for (const v of history) {
    if (v.local_file === safeName) {
      v.delogo = args.delogo;
      v.size_mb = Number((stat.size / (1024 * 1024)).toFixed(2));
      found = true;
      break;
    }
  }
  if (!found) {
    const { w, h, duration } = probeVideo(mp4Path);
    history.unshift({
      id: safeName.split("_")[0],
      title: safeName,
      uploader: "",
      duration_sec: duration,
      resolution: `${w}x${h}`,
      thumbnail: "",
      webpage_url: "",
      size_mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
      delogo: args.delogo,
      local_file: safeName,
      downloaded_at: new Date().toISOString().slice(0, 19),
    });
  }
  saveHistory(history);
  console.log(`[OK] Đã cập nhật file sạch logo: ${safeName}`);
}

function normalizeSection(sec) {
  const s = (sec || "").trim();
  if (!s) return "";
  // Accept "00:00:00-01:00:00" or "*00:00:00-01:00:00"
  return s.startsWith("*") ? s : `*${s}`;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.delogoFile) {
    await runStandaloneDelogo(args);
    return;
  }

  if (!args.url) {
    console.error("Thiếu --url (ví dụ: https://www.bilibili.com/video/BV1dT421e7TF/)");
    process.exit(1);
  }

  assertDiskSpace(args.outDir, MIN_FREE_GB);

  const formatSel =
    args.quality === "720p"
      ? "bv*[height<=720]+ba/b[height<=720]/best"
      : "bv*+ba/best";

  const secTag = args.section
    ? "_sec_" + args.section.replace(/[^0-9a-zA-Z-]+/g, "")
    : "";
  const outputTemplate = path.join(args.outDir, `%(id)s_p%(playlist_index|1)s${secTag}_%(title).50s.%(ext)s`);

  const usePlaylist = args.playlist || Boolean(args.playlistItems);
  const ytdlpArgs = [
    usePlaylist ? "--yes-playlist" : "--no-playlist",
    "--newline",
    "--continue",
    "--retries",
    "20",
    "--fragment-retries",
    "20",
    "--socket-timeout",
    "30",
    "-f",
    formatSel,
    "--merge-output-format",
    "mp4",
    "--restrict-filenames",
    "--write-info-json",
    "--no-write-playlist-metafiles",
    "-o",
    outputTemplate,
    "--print",
    "after_move:SAVED_FILE:::%(filepath)s",
  ];

  if (args.playlistItems) {
    ytdlpArgs.push("--playlist-items", args.playlistItems.trim());
  }
  if (args.section) {
    ytdlpArgs.push("--download-sections", normalizeSection(args.section));
  }
  ytdlpArgs.push(args.url);

  console.log(`[Bilibili/yt-dlp] Đang tải: ${args.url}`);
  if (args.section) console.log(`[Section] Chỉ tải khung giờ: ${args.section}`);
  if (args.playlistItems) console.log(`[Playlist] Chỉ tải các phần: ${args.playlistItems}`);

  const niceLevel = args.perf === "eco" ? 15 : 5;
  const { savedFiles } = await runStreamingCmd("yt-dlp", ytdlpArgs, { niceLevel });

  const history = loadHistory();
  const byFile = new Map(history.map((v) => [v.local_file, v]));

  for (const mp4Path of savedFiles) {
    if (!fs.existsSync(mp4Path)) continue;

    if (args.delogo && args.delogo !== "none") {
      await removeLogoInPlace(mp4Path, args.delogo, args.perf);
    }

    const filename = path.basename(mp4Path);
    const stat = fs.statSync(mp4Path);
    const infoPath = mp4Path.replace(/\.mp4$/i, ".info.json");
    let info = {};
    if (fs.existsSync(infoPath)) {
      try {
        info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      } catch {}
    }
    const probed = probeVideo(mp4Path);

    const baseTitle = info.title || filename;
    const titleWithSec = args.section ? `${baseTitle} [${args.section}]` : baseTitle;

    const entry = {
      id: info.id || filename.split("_")[0],
      title: titleWithSec,
      uploader: info.uploader || "",
      duration_sec: probed.duration || (info.duration ? Math.round(info.duration) : 0),
      resolution:
        (probed.w && probed.h ? `${probed.w}x${probed.h}` : "") ||
        info.resolution ||
        "",
      thumbnail: info.thumbnail || "",
      webpage_url: info.webpage_url || args.url,
      size_mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
      delogo: args.delogo || "none",
      local_file: filename,
      downloaded_at: new Date().toISOString().slice(0, 19),
    };
    byFile.set(filename, entry);
    console.log(`[OK] Đã lưu: ${filename} (${entry.size_mb} MB | ${entry.resolution} | delogo=${entry.delogo})`);
  }

  const updated = [...byFile.values()].sort((a, b) =>
    (b.downloaded_at || "").localeCompare(a.downloaded_at || "")
  );
  saveHistory(updated);
  console.log(`[Done] Tổng cộng ${updated.length} video Bilibili/YouTube trong thư viện.`);
}

main().catch((err) => {
  console.error("[Error]", err.message);
  process.exit(1);
});
