#!/usr/bin/env node
/**
 * Douyin Channel Video Lister (Web Mode via Visible Chrome + Network Interception)
 * - No ADB / phone connection required.
 * - Opens Douyin channel in a visible Google Chrome window with persistent profile.
 * - If Douyin asks for login or verification, wait for the user to complete it in Chrome UI.
 * - Automatically captures /aweme/v1/web/aweme/post/ responses while scrolling,
 *   extracting aweme_id, video_url, download_url (MP4), cover_url, episode, title,
 *   publish date, duration, and stats, saving incrementally to data/videos.json & data/videos.csv.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PROFILE_DIR = path.join(__dirname, "chrome_profile");
const DEFAULT_JSON = path.join(DATA_DIR, "videos.json");
const DEFAULT_CSV = path.join(DATA_DIR, "videos.csv");
const DEFAULT_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3,
  四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function chineseToInt(text) {
  const s = (text || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let current = 0;
  let hasAny = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
      hasAny = true;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      hasAny = true;
      if (current === 0) current = 1;
      if (unit === 10000) total = (total + current) * unit;
      else total += current * unit;
      current = 0;
    } else {
      return null;
    }
  }
  return hasAny ? total + current : null;
}

function extractEpisode(title) {
  const raw = title || "";
  const cleaned = raw.replace(/【[^】]*】/g, " ");
  for (const candidate of [cleaned, raw]) {
    let m = candidate.match(/第?\s*(\d+)\s*[-~—至到]\s*(\d+)\s*[集话期]/);
    if (m) return { num: Number(m[1]), label: `${m[1]}-${m[2]}` };

    m = candidate.match(/第\s*(\d+)\s*[集话期]/);
    if (m) return { num: Number(m[1]), label: m[1] };

    m = candidate.match(/第\s*([零〇一二两三四五六七八九十百千万]+)\s*[集话期]/);
    if (m) {
      const n = chineseToInt(m[1]);
      if (n !== null) return { num: n, label: String(n) };
    }

    m = candidate.match(/(\d+)\s*[集话期]/);
    if (m) return { num: Number(m[1]), label: m[1] };

    m = candidate.match(/([零〇一二两三四五六七八九十百千万]+)\s*[集话期]/);
    if (m) {
      const n = chineseToInt(m[1]);
      if (n !== null) return { num: n, label: String(n) };
    }
  }
  return { num: null, label: "" };
}

function formatDate(unixSec) {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCount(n) {
  const num = Number(n || 0);
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
  return String(num);
}

function parseAwemeItem(item) {
  const awemeId = String(item.aweme_id || "");
  if (!awemeId) return null;

  const title = (item.desc || "").trim();
  const ep = extractEpisode(title);
  const stats = item.statistics || {};
  const video = item.video || {};

  // Pick best non-watermark play URL from play_addr or bit_rate
  let downloadUrl = "";
  if (Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
    const sorted = [...video.bit_rate].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
    const urls = sorted[0]?.play_addr?.url_list || [];
    downloadUrl = urls[urls.length - 1] || urls[0] || "";
  }
  if (!downloadUrl) {
    const urls = video.play_addr?.url_list || [];
    downloadUrl = urls[urls.length - 1] || urls[0] || "";
  }

  const coverUrl =
    video.origin_cover?.url_list?.[0] ||
    video.cover?.url_list?.[0] ||
    item.images?.[0]?.url_list?.[0] ||
    "";

  const hashtags = [...title.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
  const isImagePost = item.aweme_type === 68 || (Array.isArray(item.images) && item.images.length > 0 && !downloadUrl);

  return {
    aweme_id: awemeId,
    media_type: isImagePost ? "image" : "video",
    pinned: Boolean(item.is_top),
    episode_num: ep.num,
    episode_label: ep.label,
    title,
    publish_time: item.create_time || 0,
    publish_date: formatDate(item.create_time),
    duration_sec: video.duration ? Math.round(video.duration / 1000) : 0,
    likes: stats.digg_count || 0,
    likes_raw: formatCount(stats.digg_count),
    comments: stats.comment_count || 0,
    comments_raw: formatCount(stats.comment_count),
    collects: stats.collect_count || 0,
    collects_raw: formatCount(stats.collect_count),
    shares: stats.share_count || 0,
    shares_raw: formatCount(stats.share_count),
    video_url: `https://www.douyin.com/video/${awemeId}`,
    download_url: downloadUrl,
    cover_url: coverUrl,
    hashtags,
    reup_status: "pending",
  };
}

function csvEscape(val) {
  return `"${String(val ?? "").replace(/"/g, '""')}"`;
}

function saveOutputs(videosMap, meta, jsonPath, csvPath) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });

  const videos = [...videosMap.values()].map((v, idx) => ({
    index: idx + 1,
    ...v,
  }));

  const payload = {
    source: "douyin_web",
    updated_at: new Date().toISOString().slice(0, 19),
    channel_meta: meta,
    total_collected: videos.length,
    videos,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const headers = [
    "index", "aweme_id", "media_type", "episode_num", "episode_label",
    "title", "publish_date", "duration_sec", "likes", "comments",
    "collects", "shares", "video_url", "download_url", "cover_url",
    "hashtags", "reup_status",
  ];
  const lines = [headers.join(",")];
  for (const v of videos) {
    const row = headers.map((h) => {
      if (h === "hashtags") return csvEscape((v.hashtags || []).map((x) => `#${x}`).join(" "));
      return csvEscape(v[h]);
    });
    lines.push(row.join(","));
  }
  fs.writeFileSync(csvPath, "\uFEFF" + lines.join("\n"), "utf8");
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    limit: 0,
    maxScrolls: 250,
    staleLimit: 18,
    delayMs: 2500,
    resume: false,
    json: DEFAULT_JSON,
    csv: DEFAULT_CSV,
    chrome: "/usr/bin/google-chrome",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) args.url = argv[++i];
    else if (a === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === "--max-scrolls" && argv[i + 1]) args.maxScrolls = Number(argv[++i]);
    else if (a === "--stale-limit" && argv[i + 1]) args.staleLimit = Number(argv[++i]);
    else if (a === "--delay" && argv[i + 1]) args.delayMs = Number(argv[++i]) * 1000;
    else if (a === "--resume") args.resume = true;
    else if (a === "--json" && argv[i + 1]) args.json = argv[++i];
    else if (a === "--csv" && argv[i + 1]) args.csv = argv[++i];
    else if (a === "--chrome" && argv[i + 1]) args.chrome = argv[++i];
  }
  return args;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const videosMap = new Map();
  const meta = {
    channel_name: "楚新钓",
    douyin_id: "76602931608",
    share_url: "https://v.douyin.com/4I831MTYhcg/",
    channel_url: args.url,
    total_works: "",
  };

  if (args.resume && fs.existsSync(args.json)) {
    try {
      const old = JSON.parse(fs.readFileSync(args.json, "utf8"));
      Object.assign(meta, old.channel_meta || {});
      for (const v of old.videos || []) {
        if (v.aweme_id) videosMap.set(String(v.aweme_id), v);
      }
      console.log(`[Resume] Đã tải sẵn ${videosMap.size} video từ ${args.json}`);
    } catch (e) {
      console.warn(`[Resume] Không đọc được file cũ: ${e.message}`);
    }
  }

  let hasMore = true;
  let lastBatchAt = Date.now();
  let receivedFirstApi = false;
  let apiBatchCount = 0;

  console.log(`[Web] Đang mở Google Chrome tới kênh: ${args.url}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: args.chrome,
    headless: false,
    viewport: { width: 1366, height: 900 },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const page = context.pages()[0] || (await context.newPage());

  page.on("response", async (res) => {
    const url = res.url();
    try {
      if (url.includes("/aweme/v1/web/user/profile/other/")) {
        const data = await res.json();
        const u = data?.user;
        if (u) {
          meta.channel_name = u.nickname || meta.channel_name;
          meta.douyin_id = u.unique_id || u.short_id || meta.douyin_id;
          meta.total_works = String(u.aweme_count || meta.total_works);
          meta.followers = String(u.follower_count || "");
          meta.sec_uid = u.sec_uid || meta.sec_uid;
          console.log(
            `[Channel] ${meta.channel_name} | ID: ${meta.douyin_id} | Tổng tác phẩm: ${meta.total_works}`
          );
        }
      } else if (url.includes("/aweme/v1/web/aweme/post/")) {
        const data = await res.json();
        receivedFirstApi = true;
        apiBatchCount++;
        lastBatchAt = Date.now();
        if (data?.has_more === 0) hasMore = false;

        const list = data?.aweme_list || [];
        let added = 0;
        for (const item of list) {
          const parsed = parseAwemeItem(item);
          if (!parsed) continue;
          if (!videosMap.has(parsed.aweme_id)) {
            videosMap.set(parsed.aweme_id, parsed);
            added++;
          }
        }
        saveOutputs(videosMap, meta, args.json, args.csv);
        const totalHint = meta.total_works ? `/${meta.total_works}` : "";
        console.log(
          `[API] +${String(added).padStart(2, "0")} mới (batch ${list.length}) | Tổng: ${videosMap.size}${totalHint} video | has_more=${data?.has_more}`
        );
      }
    } catch {
      // Ignore non-JSON or aborted responses
    }
  });

  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 90000 });

  // Wait up to 5 minutes for initial video list to load.
  // If Douyin displays login/verification challenge, user can complete it directly in Chrome.
  const waitStart = Date.now();
  let warnedUser = false;
  while (!receivedFirstApi && Date.now() - waitStart < 300_000) {
    if (!warnedUser && Date.now() - waitStart > 6000) {
      warnedUser = true;
      console.log(
        "[Chờ người dùng] Douyin web đang yêu cầu xác minh hoặc đăng nhập trên cửa sổ Chrome. " +
          "Hãy hoàn tất xác minh/đóng popup trực tiếp trên Chrome, tool sẽ tự động quét ngay sau đó..."
      );
    }
    await sleep(1000);
  }

  if (!receivedFirstApi) {
    console.log(
      "[Stopped] Chưa nhận được danh sách video từ Douyin web sau 90 giây (có thể vẫn đang chờ xác minh/CAPTCHA trên Chrome)."
    );
    await context.close();
    process.exit(2);
  }

  // Smoothly scroll down until all videos are loaded or --limit reached
  let staleRounds = 0;
  let prevBatchCount = apiBatchCount;

  for (let i = 1; i <= args.maxScrolls; i++) {
    if (args.limit > 0 && videosMap.size >= args.limit) {
      console.log(`[Done] Đã đạt giới hạn --limit ${args.limit} video.`);
      break;
    }
    if (!hasMore && Date.now() - lastBatchAt > 3000) {
      console.log("[Done] Douyin báo has_more=0 (đã hết danh sách video của kênh).");
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      // Also scroll any internal scrollable container Douyin may use
      for (const el of document.querySelectorAll("div")) {
        if (el.scrollHeight > el.clientHeight + 200) {
          const style = getComputedStyle(el);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            el.scrollTop = el.scrollHeight;
          }
        }
      }
    });
    await page.mouse.wheel(0, 2400);
    await sleep(args.delayMs);

    if (apiBatchCount === prevBatchCount) {
      staleRounds++;
      if (staleRounds >= args.staleLimit) {
        console.log(`[Done] Không có API batch mới sau ${args.staleLimit} lượt cuộn.`);
        break;
      }
    } else {
      staleRounds = 0;
      prevBatchCount = apiBatchCount;
    }
  }

  saveOutputs(videosMap, meta, args.json, args.csv);
  console.log(`[Saved] Hoàn tất ${videosMap.size} video -> ${args.json} & ${args.csv}`);
  await context.close();
}

main().catch((err) => {
  console.error("[Error]", err.message);
  process.exit(1);
});
