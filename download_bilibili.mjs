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
const VENV_BIN = path.join(__dirname, ".venv", "bin");
if (fs.existsSync(VENV_BIN) && !(process.env.PATH || "").split(path.delimiter).includes(VENV_BIN)) {
  process.env.PATH = `${VENV_BIN}${path.delimiter}${process.env.PATH || ""}`;
}
const OUT_DIR = path.join(__dirname, "downloads", "bilibili");
const META_JSON = path.join(__dirname, "data", "bilibili.json");
const MIN_FREE_GB = 5;

function normalizeVideoUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  // Bilibili giao diện quốc tế (/en/video/BV..., /vi/video/BV...) khiến yt-dlp rơi về generic extractor và báo lỗi đuôi .html
  return s.replace(/^(https?:\/\/(?:www\.|m\.)?bilibili\.com)\/[a-z]{2}(?:-[a-z]{2})?\/(video\/)/i, "$1/$2");
}

function parseArgs(argv) {
  const args = {
    url: "",
    playlist: false,
    playlistItems: "",
    section: "",
    outDir: OUT_DIR,
    quality: "best",
    delogo: "none",
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
  args.url = normalizeVideoUrl(args.url);
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
function runStreamingCmd(cmd, args, { niceLevel = 0, onLine = null, onSavedFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const finalCmd = niceLevel > 0 ? "nice" : cmd;
    const finalArgs = niceLevel > 0 ? ["-n", String(niceLevel), cmd, ...args] : args;

    const proc = spawn(finalCmd, finalArgs, { cwd: __dirname });
    const savedFiles = [];
    let partial = "";

    const handleSaved = (fp) => {
      savedFiles.push(fp);
      if (onSavedFile) {
        try {
          onSavedFile(fp);
        } catch {}
      }
    };

    proc.stdout.on("data", (buf) => {
      const chunk = buf.toString("utf8");
      if (!onLine) process.stdout.write(chunk);
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() || "";
      for (const line of lines) {
        if (onLine) onLine(line);
        else if (line.startsWith("SAVED_FILE:::")) {
          handleSaved(line.slice("SAVED_FILE:::".length).trim());
        }
      }
    });
    proc.stderr.on("data", (buf) => {
      process.stderr.write(buf.toString("utf8"));
    });
    proc.on("close", (code) => {
      if (partial.startsWith("SAVED_FILE:::")) {
        handleSaved(partial.slice("SAVED_FILE:::".length).trim());
      }
      if (code === 0) resolve({ savedFiles });
      else {
        const err = new Error(`${cmd} thoát với mã lỗi ${code}`);
        err.savedFiles = savedFiles;
        reject(err);
      }
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

  const { w, h, duration } = probeVideo(mp4Path);
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

  // Video dài mã hóa lại mất nhiều giờ: báo % + thời gian còn lại cho giao diện (server đọc dòng @@PROGRESS).
  const startedAt = Date.now();
  let lastEmit = 0;
  const onLine = (line) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (!m || !duration || Date.now() - lastEmit < 2000) return;
    lastEmit = Date.now();
    const frac = Math.min(1, Number(m[1]) / 1e6 / duration);
    const eta = frac > 0.005 ? Math.round(((Date.now() - startedAt) / 1000) * (1 - frac) / frac) : null;
    console.log(
      "@@PROGRESS " +
        JSON.stringify({ pct: Number((frac * 100).toFixed(1)), label: `Đang xóa logo ${fmtClock(frac * duration)} / ${fmtClock(duration)}`, eta })
    );
  };

  try {
    await runStreamingCmd(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
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
      { niceLevel, onLine }
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

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function clockToSec(t) {
  return String(t || "").split(":").reduce((a, x) => a * 60 + Number(x || 0), 0);
}

/**
 * Hỏi yt-dlp thời lượng + dung lượng ước tính TRƯỚC khi tải, để video 9–90 tiếng không làm đầy ổ giữa chừng.
 * Không lấy được thông tin (mạng, site lạ) thì bỏ qua, vẫn tải bình thường.
 */
function preflight(args, formatSel, usePlaylist) {
  let out = "";
  try {
    out = execFileSync(
      "yt-dlp",
      [
        usePlaylist ? "--yes-playlist" : "--no-playlist",
        ...(args.playlistItems ? ["--playlist-items", args.playlistItems.trim()] : []),
        "-f",
        formatSel,
        "--print",
        "%(duration|0)s|%(filesize,filesize_approx|0)s",
        args.url,
      ],
      { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return;
  }
  let totalSec = 0;
  let totalBytes = 0;
  let count = 0;
  for (const line of out.split("\n")) {
    const [d, b] = line.trim().split("|").map(Number);
    if (!d) continue;
    count++;
    let frac = 1;
    if (args.section) {
      const [from, to] = args.section.replace(/^\*/, "").split("-").map(clockToSec);
      frac = Math.min(1, Math.max(0, (Math.min(to || d, d) - from) / d));
    }
    totalSec += d * frac;
    totalBytes += (b || 0) * frac;
  }
  if (!count) return;
  const estGb = totalBytes / 1024 ** 3;
  console.log(
    `[Kiểm tra] ${count} video · tổng thời lượng ${fmtClock(totalSec)}` +
      (estGb ? ` · ước tính ${estGb.toFixed(2)} GB` : " · không rõ dung lượng")
  );
  if (estGb) {
    // Tải hình + tiếng riêng rồi ghép (~2x), xóa logo ghi thêm 1 bản tạm (~1.4x).
    const withDelogo = args.delogo && args.delogo !== "none";
    assertDiskSpace(args.outDir, Math.max(MIN_FREE_GB, estGb * (withDelogo ? 2.5 : 2.1) + 2));
  }
  if (totalSec > 4 * 3600 && args.delogo && args.delogo !== "none") {
    console.log(
      "[Gợi ý] Video rất dài: nên chọn 'Không xóa logo' khi tải, rồi bật 'Xóa logo' ngay trong bước Lồng tiếng để chỉ phải mã hóa video 1 lần."
    );
  }
}

let cachedAria2 = null;
function hasAria2() {
  if (cachedAria2 === null) {
    try {
      execFileSync("aria2c", ["--version"], { stdio: "ignore" });
      cachedAria2 = true;
    } catch {
      cachedAria2 = false;
    }
  }
  return cachedAria2;
}

const BILI_MIRROR_FALLBACKS = [
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
];

function hasPendingAria2State(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".part.aria2"));
  } catch {
    return false;
  }
}

/**
 * Sửa tự động lỗi CDN Akamai (`upos-hz-mirrorakam.akamaized.net`) làm hỏng cache một mảnh 1 MB lẻ (`Got EOF` ở 99%):
 * Giải mã file nhị phân `.part.aria2` để tìm đúng các mảnh 1 MB còn thiếu (`bit === 0`), tải các mảnh đó từ mirror dự phòng
 * của Bilibili (`upos-sz-mirrorcosov.bilivideo.com`...), ghi trực tiếp vào đúng vị trí offset của `.part`, đổi tên thành
 * `.mp4` hoàn chỉnh của video stream và xóa `.part.aria2` để yt-dlp ghép ngay với audio `.m4a`!
 */
async function healStuckAria2Parts(outDir, baseUrl) {
  if (!fs.existsSync(outDir)) return 0;
  const ariaFiles = fs.readdirSync(outDir).filter((f) => f.endsWith(".part.aria2"));
  if (!ariaFiles.length) return 0;

  let healed = 0;
  for (const ariaName of ariaFiles) {
    const ariaPath = path.join(outDir, ariaName);
    const partPath = ariaPath.slice(0, -".aria2".length); // ...f100023.mp4.part
    if (!fs.existsSync(partPath)) continue;

    // Trích format_id và số tập (p2, p3...) từ tên file: BV17djG63EV5_p7_p7_...f100023.mp4.part
    const mFmt = /\.f(\d+)\.[a-z0-9]+\.part$/i.exec(partPath);
    const mPart = /^[A-Za-z0-9]+_p(\d+)_/.exec(ariaName);
    if (!mFmt) continue;
    const fmtId = mFmt[1];
    const partNum = mPart ? Number(mPart[1]) : 1;

    let buf;
    try {
      buf = fs.readFileSync(ariaPath);
    } catch {
      continue;
    }
    const infoHashLen = buf.readUInt32BE(6);
    let off = 10 + infoHashLen;
    const pieceLen = buf.readUInt32BE(off);
    off += 4;
    const totalLen = Number(buf.readBigUInt64BE(off));
    off += 8;
    off += 8; // uploadLen
    const bitfieldLen = buf.readUInt32BE(off);
    off += 4;
    const bitfield = buf.subarray(off, off + bitfieldLen);

    const totalPieces = Math.ceil(totalLen / pieceLen);
    const missing = [];
    for (let i = 0; i < totalPieces; i++) {
      if (!(bitfield[Math.floor(i / 8)] & (1 << (7 - (i % 8))))) missing.push(i);
    }

    // Chỉ can thiệp vá nhanh khi file đã tải >95% và chỉ bị kẹt vài mảnh lẻ trên Akamai (<= 32 mảnh)
    if (missing.length > 32) continue;

    if (missing.length > 0) {
      console.log(
        `[CDN Heal] Phát hiện ${path.basename(partPath)} kẹt ${missing.length}/${totalPieces} mảnh trên CDN chính — đang lấy mảnh thiếu qua CDN dự phòng...`
      );
      let rawStreamUrl = "";
      try {
        const pageUrl = baseUrl.includes("bilibili.com")
          ? `${baseUrl.split("?")[0].replace(/\/?$/, "/")}?p=${partNum}`
          : baseUrl;
        rawStreamUrl = execFileSync("yt-dlp", ["-f", fmtId, "--get-url", pageUrl], {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split(/\r?\n/)[0];
      } catch {
        continue;
      }
      if (!rawStreamUrl) continue;

      const origHost = new URL(rawStreamUrl).host;
      const candidateUrls = [
        ...BILI_MIRROR_FALLBACKS.filter((h) => h !== origHost).map((h) => rawStreamUrl.replace(origHost, h)),
        rawStreamUrl,
      ];

      const fd = fs.openSync(partPath, "r+");
      let allPatched = true;
      try {
        for (const idx of missing) {
          const start = idx * pieceLen;
          const end = Math.min(totalLen, start + pieceLen) - 1;
          const expectedLen = end - start + 1;
          let patched = false;

          for (const u of candidateUrls) {
            try {
              const res = await fetch(u, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                  Referer: "https://www.bilibili.com/",
                  Range: `bytes=${start}-${end}`,
                },
              });
              if (res.status === 206) {
                const chunk = Buffer.from(await res.arrayBuffer());
                if (chunk.length === expectedLen) {
                  fs.writeSync(fd, chunk, 0, chunk.length, start);
                  patched = true;
                  break;
                }
              }
            } catch {}
          }
          if (!patched) {
            allPatched = false;
            break;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      if (!allPatched) continue;
    }

    // Kiểm tra kích thước chuẩn xác 100%, gỡ đuôi .part và xóa .aria2 để yt-dlp dùng ghép luôn
    const finalStreamPath = partPath.slice(0, -".part".length);
    const st = fs.statSync(partPath);
    if (st.size === totalLen) {
      fs.renameSync(partPath, finalStreamPath);
      fs.unlinkSync(ariaPath);
      healed++;
      console.log(`[CDN Heal] Đã khôi phục hoàn chỉnh 100%: ${path.basename(finalStreamPath)}`);
    }
  }
  return healed;
}

/**
 * CDN Bilibili bóp mỗi kết nối còn ~1 MB/s sau vài giây đầu.
 * QUAN TRỌNG: Khi trên đĩa đã có file `.part.aria2`, file `.part` đã được aria2c ghi tới mảnh cuối
 * (độ dài file trên đĩa = 100% dung lượng thật dù còn lỗ hổng ở giữa). Nếu chuyển sang yt-dlp thuần
 * (`--http-chunk-size 10M`), yt-dlp sẽ gửi `Range: bytes=<full_size>-` và bị lỗi `HTTP 416`!
 * Vì vậy nếu có `.part.aria2` hoặc có aria2c: luôn giữ aria2c, giảm số luồng ở các vòng sau + bật `--lowest-speed-limit`
 * để tự ngắt các kết nối bị CDN Akamai treo/EOF ở mảnh cuối.
 */
function downloaderArgs(attempt, outDir) {
  if (hasAria2() && (attempt <= 2 || hasPendingAria2State(outDir))) {
    const conns = attempt <= 2 ? 16 : 4;
    return [
      "--downloader",
      "aria2c",
      "--downloader-args",
      `aria2c:-x ${conns} -s ${conns} -k 1M --disable-ipv6=true --connect-timeout=15 --timeout=20 --lowest-speed-limit=15K --file-allocation=none --summary-interval=3 --console-log-level=warn --retry-wait=5 --max-tries=25`,
    ];
  }
  return ["--http-chunk-size", "10M"];
}

function registerSavedVideo(mp4Path, args) {
  if (!fs.existsSync(mp4Path)) return null;
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

  const history = loadHistory();
  const byFile = new Map(history.map((v) => [v.local_file, v]));
  byFile.set(filename, entry);
  const updated = [...byFile.values()].sort((a, b) =>
    (b.downloaded_at || "").localeCompare(a.downloaded_at || "")
  );
  saveHistory(updated);
  return entry;
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
    "50",
    "--fragment-retries",
    "50",
    "--retry-sleep",
    "linear=2:30:2",
    "--socket-timeout",
    "30",
    "--concurrent-fragments",
    "4",
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

  // Có file cookies.txt (xuất từ trình duyệt đã đăng nhập) thì mới tải được 1080P cao / 4K của Bilibili.
  const cookiesFile = path.join(__dirname, "cookies.txt");
  if (fs.existsSync(cookiesFile)) ytdlpArgs.push("--cookies", cookiesFile);

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

  preflight(args, formatSel, usePlaylist);
  console.log(
    hasAria2()
      ? "[Tăng tốc] Dùng aria2c 16 kết nối song song."
      : "[Tăng tốc] Chưa cài aria2c — tải kiểu chia khúc 10 MB (chậm hơn ~2 lần). Cài thêm: sudo apt install aria2"
  );

  // Tải vài chục GB khó tránh rớt mạng: thử lại cả lệnh, yt-dlp + aria2c tự nối tiếp file .part đang dở.
  const niceLevel = args.perf === "eco" ? 15 : 5;
  const MAX_TRIES = 6;
  const saved = new Set();
  const onSavedFile = (fp) => {
    saved.add(fp);
    // Lưu ngay tiêu đề + metadata vào bilibili.json ngay khi xong từng tập (không cần chờ hết playlist)
    if (!args.delogo || args.delogo === "none") {
      registerSavedVideo(fp, args);
    }
  };

  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1 || hasPendingAria2State(args.outDir)) {
        await healStuckAria2Parts(args.outDir, args.url);
      }
      const cmdArgs = [...downloaderArgs(attempt, args.outDir), ...ytdlpArgs];
      (await runStreamingCmd("yt-dlp", cmdArgs, { niceLevel, onSavedFile })).savedFiles.forEach((f) => saved.add(f));
      break;
    } catch (err) {
      (err.savedFiles || []).forEach((f) => saved.add(f));
      // Thử vá ngay các mảnh .aria2 bị kẹt trên Akamai trước khi vào vòng kế tiếp
      const healed = await healStuckAria2Parts(args.outDir, args.url);
      if (attempt >= MAX_TRIES && !healed) throw err;
      console.log(`[Thử lại] Lần ${attempt}/${MAX_TRIES} bị gián đoạn (${err.message}). Tự nối tiếp sau 5 giây...`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const savedFiles = [...saved];

  for (const mp4Path of savedFiles) {
    if (!fs.existsSync(mp4Path)) continue;

    if (args.delogo && args.delogo !== "none") {
      await removeLogoInPlace(mp4Path, args.delogo, args.perf);
    }

    const entry = registerSavedVideo(mp4Path, args);
    if (entry) {
      console.log(`[OK] Đã lưu: ${entry.local_file} (${entry.size_mb} MB | ${entry.resolution} | delogo=${entry.delogo})`);
    }
  }

  const updated = loadHistory();
  console.log(`[Done] Tổng cộng ${updated.length} video Bilibili/YouTube trong thư viện.`);
}

main().catch((err) => {
  console.error("[Error]", err.message);
  process.exit(1);
});
