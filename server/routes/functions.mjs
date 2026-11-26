/**
 * Hàm cho model gọi (function calling / MCP / code mode): mỗi hàm là 1 thao tác của Studio kèm JSON Schema tham số.
 *   GET  /api/functions            danh sách hàm, đúng định dạng `tools` của OpenAI
 *   POST /api/functions/call       {name, arguments, wait_sec?} -> chạy hàm, trả bản ghi lần gọi
 *   GET  /api/functions/calls      nhật ký các lần gọi (?limit=&status=&name=)
 *   GET  /api/functions/calls/:id  1 lần gọi: trạng thái, kết quả (đường dẫn file), lỗi đầy đủ, file log
 * Hàm không tự làm gì mới: gọi lại đúng route /api/* mà giao diện đang dùng (app.inject) nên kiểm tra dữ liệu chỉ có 1 chỗ.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DUBBED_DIR, DUB_PROJECTS_DIR, ROOT } from "../config.mjs";
import { db } from "../lib/db.mjs";
import { readDubJobs, readDubbed } from "../lib/store.mjs";
import { taskEvents } from "../lib/tasks.mjs";
import { nowIso, relOf, resolveDownload } from "../lib/util.mjs";

const LOG_DIR = path.join(DATA_DIR, "function_logs");
const MAX_WAIT_SEC = 3600;

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });

const P_DELOGO = str('Xóa logo: "none" | "top-right" | "top-left" | "both-top" | vùng pixel "x,y,w,h" trên khung hình gốc.');
const P_SUBCOVER = str('Xóa phụ đề gốc tiếng Trung: "none" hoặc vùng pixel "x,y,w,h" bao quanh dòng phụ đề.');
const P_VOICE = str('Giọng đọc: "vieneu:<tên preset>" hoặc "vieneu-clone:<slug>". Lấy danh sách bằng list_options.');
const P_PROJECT = str("Mã dự án truyện (id trong list_options.projects) để dùng chung nhân vật / thuật ngữ. Bỏ trống = không gắn dự án.");
const P_SUB_STYLE = {
  type: "object",
  description: "Kiểu phụ đề Việt in cứng. Bỏ trống = mặc định (chữ trắng, nền đen 87%).",
  properties: {
    font: str("Tên font (family) trong list_options.fonts."),
    size_pct: num("Cỡ chữ, % so với cỡ tự tính.", { minimum: 40, maximum: 250 }),
    bold: bool("Chữ đậm."),
    color: str("Màu chữ #RRGGBB."),
    bg: str("Màu nền sau chữ #RRGGBB."),
    bg_opacity: num("Độ đặc của nền, 0 = không nền.", { minimum: 0, maximum: 100 }),
    outline: str("Màu viền chữ #RRGGBB."),
    outline_width: num("Độ dày viền chữ, 0 = không viền."),
  },
  additionalProperties: false,
};

/** Đường dẫn trả cho model: tuyệt đối (mở file) + tương đối (truyền lại vào hàm khác) + url xem trên Studio. */
const fileInfo = (abs) => ({ path: abs, rel_path: relOf(abs), url: "/" + relOf(abs).split("/").map(encodeURIComponent).join("/") });

function dubResult(job) {
  if (!job) return {};
  const done = readDubbed().find((v) => v.job_id === job.job_id) || {};
  const out = { job_id: job.job_id, project_file: path.join(DUB_PROJECTS_DIR, `${job.job_id}.json`) };
  for (const [k, f] of [["video", done.mp4_file || `${job.job_id}.mp4`], ["subtitle", done.srt_file || `${job.job_id}.srt`]]) {
    const abs = path.join(DUBBED_DIR, f);
    if (fs.existsSync(abs)) out[k] = fileInfo(abs);
  }
  for (const k of ["title", "duration_sec", "segment_count", "untranslated", "size_mb"]) if (done[k] !== undefined) out[k] = done[k];
  return out;
}
const dubJobOf = (relPath) => readDubJobs().get(resolveDownload(relPath)) || null;
const savedResult = (a, ev) => ({ files: ev.saved_files.map(fileInfo) });

/**
 * route: [method, url] của API có sẵn. task: true = chạy nền (trả ngay, kết quả đến sau). nolog: không ghi nhật ký.
 * result(args, sự kiện kết thúc) -> kết quả khi tác vụ nền xong; fail(args) -> lỗi do script ghi lại (nếu có).
 */
const FUNCTIONS = [
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
    name: "dub_video",
    description:
      "Reup 1 video: nhận diện lời thoại tiếng Trung, dịch, lồng tiếng Việt, in phụ đề, xóa logo. Chạy nền (vài phút tới vài giờ): " +
      "trả call_id ngay, dùng get_call để lấy video + phụ đề khi xong. Chạy lại cùng video sẽ nối tiếp từ chỗ dở.",
    route: ["POST", "/api/dub/start"],
    task: true,
    result: (a) => dubResult(dubJobOf(a.rel_path)),
    fail: (a) => dubJobOf(a.rel_path)?.error || "",
    parameters: {
      rel_path: str('Video nguồn, ví dụ "downloads/bilibili/abc.mp4" (lấy từ list_sources hoặc kết quả download_video).'),
      voice: P_VOICE,
      model: str("Mô hình nhận diện giọng nói (id trong list_options.asr_models).", { default: "sensevoice-small" }),
      speed: num("Tốc độ phát khi nhận diện (làm chậm để nghe rõ hơn).", { default: 0.5, minimum: 0.25, maximum: 1 }),
      bg_volume: num("Âm lượng tiếng gốc giữ lại làm nền, 0 = tắt hẳn.", { default: 0.05, minimum: 0, maximum: 1 }),
      delogo: P_DELOGO,
      subcover: P_SUBCOVER,
      burn_sub: bool("In cứng phụ đề Việt lên hình (mặc định true)."),
      multi_voice: bool("Lồng tiếng nhiều giọng: tự phân vai nhân vật và gán giọng riêng (mặc định false)."),
      agy_model: str("Model dịch của Antigravity (id trong list_options.agy_models). Bỏ trống = mặc định."),
      sub_style: P_SUB_STYLE,
      project_id: P_PROJECT,
      fresh: bool("Bỏ toàn bộ tiến độ / cache cũ của video này và làm lại từ đầu."),
    },
    required: ["rel_path"],
  },
  {
    name: "rerender_video",
    description:
      "Xuất lại 1 bản lồng tiếng đã có sau khi đổi cấu hình hoặc sửa lời thoại. Chỉ làm lại phần bị ảnh hưởng (hình hoặc tiếng). Chạy nền.",
    route: ["POST", "/api/dub/rerender"],
    task: true,
    result: (a) => dubResult({ job_id: a.job_id }),
    parameters: {
      job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed)."),
      voice: P_VOICE,
      bg_volume: num("Âm lượng tiếng gốc làm nền.", { minimum: 0, maximum: 1 }),
      burn_sub: bool("In cứng phụ đề Việt."),
      delogo: P_DELOGO,
      subcover: P_SUBCOVER,
      sub_style: P_SUB_STYLE,
      edits: { type: "object", description: 'Sửa lời Việt theo mã câu: {"12": "lời mới"}.', additionalProperties: { type: "string" } },
      speaker_voices: { type: "object", description: 'Đổi giọng của nhân vật: {"NV1": "vieneu:Hải Đăng"}.', additionalProperties: { type: "string" } },
      speaker_edits: { type: "object", description: 'Đổi người nói của câu: {"12": "NV2"}.', additionalProperties: { type: "string" } },
    },
    required: ["job_id"],
  },
  {
    name: "delogo_video",
    description: "Xóa logo trên 1 video đã tải trong downloads/bilibili (mã hóa lại, ghi đè file). Chạy nền.",
    route: ["POST", "/api/bilibili/delogo"],
    task: true,
    result: (a) => ({ files: [fileInfo(path.join(ROOT, "downloads", "bilibili", path.basename(String(a.local_file))))] }),
    parameters: {
      local_file: str("Tên file trong downloads/bilibili."),
      delogo: P_DELOGO,
      perf: str("Mức dùng máy.", { enum: ["eco", "balanced", "fast"], default: "balanced" }),
    },
    required: ["local_file"],
  },
  { name: "list_sources", description: "Liệt kê video nguồn đã tải (rel_path, thời lượng, độ phân giải, trạng thái lồng tiếng).", route: ["GET", "/api/sources"], parameters: {} },
  { name: "list_dubbed", description: "Liệt kê các bản lồng tiếng đã xuất (job_id, file mp4 / srt, cấu hình đã dùng).", route: ["GET", "/api/dubbed"], parameters: {} },
  {
    name: "assign_video_project",
    description: "Gán 1 bản lồng tiếng (job_id) vào 1 dự án Reup, để dùng chung nhân vật / thuật ngữ / mạch truyện.",
    route: ["POST", "/api/dub/assign"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed)."), project_id: str("Mã dự án (id trong list_options.projects). Bỏ trống = gỡ khỏi dự án.") },
    required: ["job_id"],
  },
  {
    name: "clean_dub_cache",
    description: "Xóa cache tạm (âm thanh giọng đã tổng hợp + hình đã mã hóa) của 1 bản lồng tiếng để lấy lại ổ cứng. Bản lồng tiếng cuối cùng vẫn được giữ.",
    route: ["POST", "/api/dub/clean"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed).") },
    required: ["job_id"],
  },
  {
    name: "delete_dub_job",
    description: "Xóa hẳn 1 bản lồng tiếng (file video/phụ đề xuất ra + toàn bộ dữ liệu câu thoại). Không thể hoàn tác.",
    route: ["POST", "/api/dub/delete"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed).") },
    required: ["job_id"],
  },
  {
    name: "list_projects",
    description: "Liệt kê đầy đủ các dự án Reup: nhân vật (tên gốc/Việt, xưng hô, tính cách, giọng), thuật ngữ, mạch truyện, danh sách video đã gán.",
    route: ["GET", "/api/projects"],
    parameters: {},
  },
  {
    name: "create_project",
    description: "Tạo dự án Reup mới để nhóm nhiều video cùng bộ truyện, dùng chung nhân vật / thuật ngữ / mạch truyện khi dịch.",
    route: ["POST", "/api/projects"],
    parameters: {
      name: str("Tên dự án."),
      type: str("Thể loại.", { default: "Truyện / Hoạt hình" }),
      style: str("Phong cách dịch & giọng văn mong muốn."),
      synopsis: str("Cốt truyện chung, càng chi tiết AI dịch càng đúng mạch."),
    },
    required: ["name"],
  },
  {
    name: "update_project",
    description:
      "Sửa thông tin dự án Reup: ngữ cảnh chung, danh sách nhân vật (mỗi nhân vật chỉ 1 giọng, chọn từ list_options.voices ở Tài nguyên) và thuật ngữ.",
    route: ["POST", "/api/projects/save"],
    parameters: {
      id: str("Mã dự án (id trong list_options.projects)."),
      name: str("Tên dự án."),
      type: str("Thể loại."),
      style: str("Phong cách dịch & giọng văn."),
      synopsis: str("Cốt truyện chung."),
      characters: {
        type: "array",
        description: "Toàn bộ danh sách nhân vật (ghi đè danh sách cũ).",
        items: {
          type: "object",
          properties: {
            zh: str("Tên gốc."), vi: str("Tên Việt."), pronouns: str("Xưng hô."), role: str("Vai trò."),
            personality: str("Tính cách, giọng điệu."), voice: str('Giọng đọc duy nhất của nhân vật, id trong list_options.voices (ví dụ "vieneu:Hải Đăng"). Bỏ trống = máy tự chọn khi lồng tiếng nhiều giọng.'),
          },
        },
      },
      glossary: { type: "array", description: "Toàn bộ từ điển thuật ngữ (ghi đè danh sách cũ).", items: { type: "object", properties: { zh: str("Từ gốc."), vi: str("Dịch tiếng Việt.") } } },
    },
    required: ["id"],
  },
  { name: "delete_project", description: "Xóa 1 dự án Reup (chỉ mất ngữ cảnh AI; các file video vẫn được giữ, trở về trạng thái chưa gán dự án).", route: ["POST", "/api/projects/delete"], parameters: { id: str("Mã dự án (id trong list_options.projects).") }, required: ["id"] },
  {
    name: "create_voice",
    description: "Thêm giọng clone mới vào Tài nguyên (dùng chung mọi dự án) từ 1 video đã tải (rel_path) hoặc 1 link audio/video.",
    route: ["POST", "/api/voices/create"],
    parameters: {
      name: str("Tên hiển thị của giọng."),
      rel_path: str('Video nguồn đã tải, ví dụ "downloads/bilibili/abc.mp4" (lấy từ list_sources). Dùng 1 trong 2: rel_path hoặc url.'),
      url: str("Link audio/video trực tiếp để lấy mẫu giọng. Dùng 1 trong 2: rel_path hoặc url."),
      gender: str("Giới tính giọng.", { enum: ["male", "female"] }),
      start: num("Giây bắt đầu đoạn mẫu trong nguồn. Bỏ trống = máy tự chọn đoạn rõ giọng nhất."),
      end: num("Giây kết thúc đoạn mẫu (nên dài 5-15s)."),
      project_id: P_PROJECT,
    },
    required: ["name"],
  },
  { name: "update_voice", description: "Đổi tên / giới tính của 1 giọng clone đã có.", route: ["POST", "/api/voices/update"], parameters: { slug: str("Mã giọng (phần sau \"vieneu-clone:\" trong id)."), name: str("Tên mới."), gender: str("Giới tính.", { enum: ["male", "female", ""] }) }, required: ["slug"] },
  { name: "delete_voice", description: "Xóa 1 giọng clone khỏi Tài nguyên (gỡ khỏi mọi dự án đang dùng).", route: ["POST", "/api/voices/delete"], parameters: { slug: str("Mã giọng (phần sau \"vieneu-clone:\" trong id).") }, required: ["slug"] },
  {
    name: "download_asr_model",
    description: "Tải 1 mô hình nhận diện giọng nói (ASR) về máy để dùng cho dub_video. Chạy nền.",
    route: ["POST", "/api/asr-models/download"],
    task: true,
    result: () => ({}),
    parameters: { id: str("Mã mô hình (id trong list_options.asr_models).") },
    required: ["id"],
  },
  { name: "delete_font", description: "Xóa 1 font chữ phụ đề đã tải lên Tài nguyên (video đang dùng font này quay về font mặc định ở lần xuất lại sau).", route: ["POST", "/api/fonts/delete"], parameters: { id: str("Mã font.") }, required: ["id"] },
  {
    name: "list_options",
    description: "Các giá trị hợp lệ cho tham số: giọng đọc, mô hình nhận diện, model dịch, dự án, font phụ đề.",
    parameters: {},
    run: async (a, get) => {
      const [voices, asr, agy, projects, fonts] = await Promise.all(
        ["/api/voices", "/api/asr-models", "/api/agy-models", "/api/projects", "/api/fonts"].map(get)
      );
      return {
        voices: [...(voices.presets || []), ...(voices.clones || [])].map((v) => ({ id: v.id, name: v.name, gender: v.gender, kind: v.kind || "vieneu" })),
        asr_models: (asr.models || []).map((m) => ({ id: m.id, name: m.name, installed: m.installed, hw: m.hw })),
        agy_models: (agy.models || []).map((m) => ({ id: m.id, name: m.name })),
        projects: (projects.projects || []).map((p) => ({ id: p.id, name: p.name, video_count: p.video_count })),
        fonts: (fonts.fonts || []).map((f) => ({ family: f.family, vi: f.vi })),
        delogo: ["none", "top-right", "top-left", "both-top", "x,y,w,h"],
        quality: ["720p", "best"],
        perf: ["eco", "balanced", "fast"],
      };
    },
  },
  {
    name: "get_task",
    nolog: true,
    description: "Tác vụ nền đang chạy: loại, tiến độ %, hàng đợi, các dòng nhật ký gần nhất.",
    parameters: { log_lines: num("Số dòng nhật ký cuối cần lấy.", { default: 30 }) },
    run: async (a, get) => {
      const t = await get("/api/task");
      return { ...t, logs: t.logs.slice(-Math.max(0, Number(a.log_lines ?? 30))) };
    },
  },
  { name: "stop_task", description: "Dừng tác vụ nền đang chạy (tiến độ lồng tiếng đã lưu, chạy lại sẽ nối tiếp).", route: ["POST", "/api/task/stop"], parameters: {} },
  {
    name: "get_call",
    nolog: true,
    description: "Xem 1 lần gọi hàm: trạng thái (queued/running/done/error/stopped), kết quả kèm đường dẫn file, lỗi đầy đủ, file log.",
    parameters: { call_id: num("Mã lần gọi (call_id)."), wait_sec: num("Chờ tối đa bấy nhiêu giây cho tới khi xong rồi mới trả.", { maximum: MAX_WAIT_SEC }) },
    required: ["call_id"],
    run: async (a) => {
      await waitCall(Number(a.call_id), a.wait_sec);
      const c = getCall(Number(a.call_id));
      if (!c) throw new Error(`Không có lần gọi nào mang call_id=${a.call_id}.`);
      return c;
    },
  },
  {
    name: "list_calls",
    nolog: true,
    description: "Nhật ký các lần gọi hàm gần đây, mới nhất trước.",
    parameters: { limit: num("Số bản ghi.", { default: 20, maximum: 200 }), status: str("Lọc theo trạng thái.", { enum: ["queued", "running", "done", "error", "stopped"] }) },
    run: async (a) => ({ calls: listCalls(a) }),
  },
];
const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

/* ---------- Nhật ký lần gọi (SQLite: bảng function_calls) ---------- */
const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return s;
  }
};
const rowOut = (r) =>
  r && {
    call_id: r.id, name: r.name, arguments: parse(r.args), status: r.status, ok: r.status !== "error" && r.status !== "stopped",
    result: parse(r.result), error: r.error || null, log_file: r.log_file || null, created_at: r.created_at, ended_at: r.ended_at,
  };
const getCall = (id) => rowOut(db.prepare("SELECT * FROM function_calls WHERE id = ?").get(id));
function listCalls({ limit, status, name } = {}) {
  const where = [];
  const params = [];
  if (status) where.push("status = ?"), params.push(String(status));
  if (name) where.push("name = ?"), params.push(String(name));
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  return db
    .prepare(`SELECT * FROM function_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params, n)
    .map(rowOut);
}
function finish(id, status, { result = null, error = null, logFile = null } = {}) {
  db.prepare("UPDATE function_calls SET status = ?, result = ?, error = ?, log_file = coalesce(?, log_file), ended_at = ? WHERE id = ?").run(
    status, result === null ? null : JSON.stringify(result), error, logFile, nowIso(), id
  );
  for (const wake of waiters.get(id) || []) wake();
  waiters.delete(id);
}

const pending = new Map(); // task_id -> {callId, def, args}
const waiters = new Map(); // call_id -> [hàm đánh thức]
function waitCall(id, sec) {
  const s = Math.min(MAX_WAIT_SEC, Number(sec) || 0);
  const c = getCall(id);
  if (!s || !c || !["queued", "running"].includes(c.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, s * 1000);
    waiters.set(id, [...(waiters.get(id) || []), () => (clearTimeout(t), resolve())]);
  });
}

/** Lỗi đầy đủ của 1 tác vụ: lỗi script tự ghi + nguyên traceback Python (nếu có), không thì 60 dòng cuối nhật ký. */
function errorText(code, logs, scriptError) {
  const tb = logs.findLastIndex((l) => l.includes("Traceback (most recent call last)"));
  const tail = (tb >= 0 ? logs.slice(tb) : logs.slice(-60)).join("\n");
  return [`Tiến trình thoát với mã ${code}.`, scriptError, tail].filter(Boolean).join("\n");
}

taskEvents.on("start", ({ task_id }) => {
  const p = pending.get(task_id);
  if (p) db.prepare("UPDATE function_calls SET status = 'running' WHERE id = ? AND status = 'queued'").run(p.callId);
});
taskEvents.on("end", (ev) => {
  const p = pending.get(ev.task_id);
  if (!p) return;
  pending.delete(ev.task_id);
  // Nhật ký của riêng lần gọi này (data/last_task.log bị ghi đè ở tác vụ kế tiếp).
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `call_${p.callId}.log`);
  fs.writeFileSync(logFile, ev.logs.join("\n") + "\n");
  try {
    if (ev.exit_code === 0) return finish(p.callId, "done", { result: p.def.result?.(p.args, ev) ?? {}, logFile });
    const stopped = ev.exit_code === null || ev.exit_code === 130;
    finish(p.callId, stopped ? "stopped" : "error", {
      error: stopped ? "Tác vụ đã bị dừng trước khi xong (tiến độ đã lưu)." : errorText(ev.exit_code, ev.logs, p.def.fail?.(p.args)),
      logFile,
    });
  } catch (e) {
    finish(p.callId, "error", { error: `Tác vụ xong nhưng không đọc được kết quả: ${e.stack || e.message}`, logFile });
  }
});

function checkArgs(def, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments phải là 1 object.";
  const unknown = Object.keys(args).filter((k) => !(k in def.parameters));
  if (unknown.length) return `Tham số không tồn tại: ${unknown.join(", ")}. Hàm ${def.name} nhận: ${Object.keys(def.parameters).join(", ") || "(không có tham số)"}.`;
  const missing = (def.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return `Thiếu tham số bắt buộc: ${missing.join(", ")}.`;
  for (const [k, v] of Object.entries(args)) {
    const want = def.parameters[k].type;
    const got = Array.isArray(v) ? "array" : typeof v;
    if (v !== null && got !== want) return `Tham số ${k} phải là ${want}, nhận được ${got}.`;
    const en = def.parameters[k].enum;
    if (en && !en.includes(v)) return `Tham số ${k} chỉ nhận: ${en.join(", ")}.`;
  }
  return "";
}

export default async function functionRoutes(app) {
  // Server bị tắt giữa chừng: các lần gọi còn "đang chạy" không bao giờ có kết quả nữa.
  db.prepare("UPDATE function_calls SET status = 'stopped', error = 'Server khởi động lại khi tác vụ chưa xong.', ended_at = ? WHERE status IN ('queued', 'running')").run(nowIso());

  const hit = async (method, url, payload) => {
    const res = await app.inject({ method, url, ...(method === "GET" ? {} : { payload: payload || {} }) });
    let body;
    try {
      body = res.json();
    } catch {
      body = { error: res.body };
    }
    if (res.statusCode >= 400 || body?.ok === false) throw new Error(body?.error || `HTTP ${res.statusCode}: ${res.body}`);
    return body;
  };
  const get = (url) => hit("GET", url);

  async function call(name, args = {}, waitSec = 0) {
    const def = BY_NAME.get(name);
    if (!def) return { ok: false, status: "error", error: `Không có hàm "${name}". Các hàm: ${FUNCTIONS.map((f) => f.name).join(", ")}.` };
    // Hàm chỉ để xem trạng thái thì không ghi vào nhật ký (model gọi lặp lại nhiều lần khi chờ).
    if (def.nolog) {
      try {
        const bad = checkArgs(def, args);
        if (bad) throw new Error(bad);
        return { ok: true, name, status: "done", result: await def.run(args, get) };
      } catch (e) {
        return { ok: false, name, status: "error", error: e.message };
      }
    }
    const callId = Number(
      db.prepare("INSERT INTO function_calls (name, args, status, created_at) VALUES (?, ?, 'running', ?)").run(name, JSON.stringify(args ?? {}), nowIso()).lastInsertRowid
    );
    try {
      const bad = checkArgs(def, args);
      if (bad) throw new Error(bad);
      const out = def.run ? await def.run(args, get) : await hit(def.route[0], def.route[1], args);
      if (!def.task) finish(callId, "done", { result: out });
      else {
        // Tác vụ nền: kết quả thật đến ở sự kiện "end" của tasks.mjs.
        pending.set(out.task_id, { callId, def, args });
        db.prepare("UPDATE function_calls SET status = ?, task_id = ?, result = ? WHERE id = ?").run(
          out.queued ? "queued" : "running", out.task_id,
          JSON.stringify({ queued: Boolean(out.queued), position: out.position || 0, note: `Đang chạy nền. Gọi get_call với call_id=${callId} (thêm wait_sec để chờ) để lấy kết quả.` }),
          callId
        );
        await waitCall(callId, waitSec);
      }
    } catch (e) {
      finish(callId, "error", { error: e.message });
    }
    return getCall(callId);
  }

  app.get("/api/functions", async () => ({
    ok: true,
    functions: FUNCTIONS.map((f) => ({
      type: "function",
      function: {
        name: f.name,
        description: f.description,
        parameters: { type: "object", properties: f.parameters, required: f.required || [], additionalProperties: false },
      },
    })),
  }));

  app.post("/api/functions/call", async (req) => {
    const body = req.body || {};
    let args = body.arguments ?? body.args ?? {};
    // OpenAI trả arguments dạng chuỗi JSON: nhận luôn để dán thẳng tool_call vào đây.
    if (typeof args === "string") {
      try {
        args = JSON.parse(args || "{}");
      } catch (e) {
        return { ok: false, status: "error", error: `arguments không phải JSON hợp lệ: ${e.message}` };
      }
    }
    return call(String(body.name || ""), args, body.wait_sec);
  });

  app.get("/api/functions/calls", async (req) => ({ ok: true, calls: listCalls(req.query || {}) }));
  app.get("/api/functions/calls/:id", async (req, reply) => {
    const c = getCall(Number(req.params.id));
    return c || reply.code(404).send({ ok: false, error: `Không có lần gọi nào mang call_id=${req.params.id}.` });
  });
}
