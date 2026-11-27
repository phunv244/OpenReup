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
import { API_TOKEN, DATA_DIR } from "../config.mjs";
import { P_PROJECT, P_VOICE, num, str } from "../core/schema.mjs";
import { db } from "../lib/db.mjs";
import { taskEvents } from "../lib/tasks.mjs";
import { nowIso } from "../lib/util.mjs";

const LOG_DIR = path.join(DATA_DIR, "function_logs");
const MAX_WAIT_SEC = 3600;


/**
 * Thứ tự hàm trong GET /api/functions. { slot: "<module>" } = chỗ đặt mọi hàm do module đó khai (server/modules/<module>/functions.mjs);
 * { ref: "<tên hàm>" } = chỗ đặt 1 hàm do module khai (khi hàm của module nằm xen kẽ). Hàm của module không có chỗ được nối vào cuối. Giữ thứ tự ổn định cho MausBot / snapshot.
 * route: [method, url] của API có sẵn. task: true = chạy nền (trả ngay, kết quả đến sau). nolog: không ghi nhật ký.
 * result(args, sự kiện kết thúc) -> kết quả khi tác vụ nền xong; fail(args) -> lỗi do script ghi lại (nếu có).
 */
export const FUNCTIONS = [
  { ref: "download_video" }, // server/modules/sources/functions.mjs
  { ref: "douyin_scan_channel" }, // server/modules/sources/functions.mjs
  { ref: "douyin_download" }, // server/modules/sources/functions.mjs
  { ref: "dub_video" }, // server/modules/dub/functions.mjs
  { ref: "rerender_video" }, // server/modules/dub/functions.mjs
  { ref: "list_segments_outline" }, // server/modules/dub/functions.mjs
  { ref: "edit_segment" }, // server/modules/dub/functions.mjs
  { ref: "split_segment" }, // server/modules/dub/functions.mjs
  { ref: "merge_segments" }, // server/modules/dub/functions.mjs
  { ref: "delete_segment" }, // server/modules/dub/functions.mjs
  { ref: "delogo_video" }, // server/modules/sources/functions.mjs
  { ref: "list_sources" }, // server/modules/sources/functions.mjs
  { ref: "list_dubbed" }, // server/modules/dub/functions.mjs
  { ref: "assign_video_project" }, // server/modules/dub/functions.mjs
  { ref: "clean_dub_cache" }, // server/modules/dub/functions.mjs
  { ref: "delete_dub_job" }, // server/modules/dub/functions.mjs
  { slot: "project" }, // list_projects, create_project, update_project, delete_project: server/modules/project/functions.mjs
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
        projects: (projects.projects || []).map((p) => ({ id: p.id, name: p.name, video_count: p.video_count, dubbed_count: p.dubbed_count, pending_count: p.pending_count })),
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

/** Xếp hàm của registry theo FUNCTIONS (slot module), phần còn lại nối cuối. */
function listingOrder(functions) {
  const out = [];
  const placed = new Set();
  const missing = [];
  const put = (f) => placed.has(f.name) || (placed.add(f.name), out.push(f));
  for (const item of FUNCTIONS) {
    if (item.slot) {
      const own = functions.filter((f) => f.module === item.slot);
      if (!own.length) missing.push(`slot "${item.slot}"`);
      own.forEach(put);
    } else {
      // Chỗ giữ của hàm mà module không khai (module chưa nạp / gõ sai tên): bỏ qua, không làm lỗi /api/functions.
      const f = functions.find((x) => x.name === (item.ref || item.name));
      if (f) put(f);
      else missing.push(`"${item.ref || item.name}"`);
    }
  }
  // Gõ sai tên trong { ref } thì hàm thật bị dời xuống cuối danh sách: báo ngay lúc khởi động.
  if (missing.length) console.warn(`[functions] Chỗ giữ trong FUNCTIONS không có hàm tương ứng (bị bỏ qua): ${missing.join(", ")}`);
  functions.forEach(put);
  return out;
}

/** functions: mọi hàm do các module khai (ctx.functions() của loader). */
export default async function functionRoutes(app, functions) {
  const BY_NAME = new Map(functions.map((f) => [f.name, f]));
  const LISTED = listingOrder(functions);
  // Server bị tắt giữa chừng: các lần gọi còn "đang chạy" không bao giờ có kết quả nữa.
  db.prepare("UPDATE function_calls SET status = 'stopped', error = 'Server khởi động lại khi tác vụ chưa xong.', ended_at = ? WHERE status IN ('queued', 'running')").run(nowIso());

  const hit = async (method, url, payload) => {
    const headers = API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}; // gọi nội bộ, đã qua xác thực ở /api/functions
    const res = await app.inject({ method, url, headers, ...(method === "GET" ? {} : { payload: payload || {} }) });
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
    if (!def) return { ok: false, status: "error", error: `Không có hàm "${name}". Các hàm: ${LISTED.map((f) => f.name).join(", ")}.` };
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
    functions: LISTED.map((f) => ({
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
