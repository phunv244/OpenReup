/**
 * Hàm cho model gọi (function calling / MCP / code mode): mỗi hàm là 1 thao tác của Studio kèm JSON Schema tham số.
 *   GET  /api/functions            danh sách hàm, đúng định dạng `tools` của OpenAI
 *   POST /api/functions/call       {name, arguments, wait_sec?} -> chạy hàm, trả bản ghi lần gọi
 *   GET  /api/functions/calls      nhật ký các lần gọi (?limit=&status=&name=)
 *   GET  /api/functions/calls/:id  1 lần gọi: trạng thái, kết quả (đường dẫn file), lỗi đầy đủ, file log
 * File này chỉ là danh sách đăng ký (thứ tự FUNCTIONS) + lớp chạy hàm: định nghĩa hàm nằm ở server/modules/<module>/functions.mjs,
 * nhật ký lần gọi ở lib/function-calls.mjs. Hàm có `route` gọi lại đúng route /api/* mà giao diện đang dùng (app.inject);
 * hàm có `run(args, get, post)` tự gom kết quả (get/post = gọi route nội bộ), hoặc đọc thẳng lib dùng chung khi chỉ xem trạng thái
 * (get_task: lib/tasks.mjs; get_call, list_calls: lib/function-calls.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { API_TOKEN, DATA_DIR } from "../config.mjs";
import { finishCall as finish, getCall, listCalls, markRunning, markTask, startCall, stopOrphans, waitCall } from "../lib/function-calls.mjs";
import { taskEvents } from "../lib/tasks.mjs";

const LOG_DIR = path.join(DATA_DIR, "function_logs");

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
  { slot: "resources" }, // create_voice, update_voice, delete_voice, download_asr_model, delete_font, list_options: server/modules/resources/functions.mjs
  { slot: "tasks" }, // get_task, stop_task, get_call, list_calls: server/modules/tasks/functions.mjs
  { slot: "ai" }, // refresh_ai_models: server/modules/ai/functions.mjs
  { slot: "threads" }, // threads_video_pipeline, threads_reup_pipeline, threads_scrape_post, threads_list_jobs: server/modules/threads/functions.mjs
];

const pending = new Map(); // task_id -> {callId, def, args}

/** Lỗi đầy đủ của 1 tác vụ: lỗi script tự ghi + nguyên traceback Python (nếu có), không thì 60 dòng cuối nhật ký. */
function errorText(code, logs, scriptError) {
  const tb = logs.findLastIndex((l) => l.includes("Traceback (most recent call last)"));
  const tail = (tb >= 0 ? logs.slice(tb) : logs.slice(-60)).join("\n");
  return [`Tiến trình thoát với mã ${code}.`, scriptError, tail].filter(Boolean).join("\n");
}

const onTaskStart = ({ task_id }) => {
  const p = pending.get(task_id);
  if (p) markRunning(p.callId);
};
const onTaskEnd = (ev) => {
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
};

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

/** functions: mọi hàm do các module khai (ctx.functions() của loader); listen: ctx.listen (gỡ bộ nghe khi app đóng). */
export default async function functionRoutes(app, functions, listen) {
  const BY_NAME = new Map(functions.map((f) => [f.name, f]));
  const LISTED = listingOrder(functions);
  // Nghe tác vụ nền để chốt kết quả lần gọi; gỡ khi app đóng (dựng lại app trong cùng tiến trình không chồng bộ nghe).
  listen(taskEvents, "start", onTaskStart);
  listen(taskEvents, "end", onTaskEnd);
  // Server bị tắt giữa chừng: các lần gọi còn "đang chạy" không bao giờ có kết quả nữa.
  stopOrphans();

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
  const post = (url, payload) => hit("POST", url, payload);

  async function call(name, args = {}, waitSec = 0) {
    const def = BY_NAME.get(name);
    if (!def) return { ok: false, status: "error", error: `Không có hàm "${name}". Các hàm: ${LISTED.map((f) => f.name).join(", ")}.` };
    // Hàm chỉ để xem trạng thái thì không ghi vào nhật ký (model gọi lặp lại nhiều lần khi chờ).
    if (def.nolog) {
      try {
        const bad = checkArgs(def, args);
        if (bad) throw new Error(bad);
        return { ok: true, name, status: "done", result: await def.run(args, get, post) };
      } catch (e) {
        return { ok: false, name, status: "error", error: e.message };
      }
    }
    const callId = startCall(name, args);
    try {
      const bad = checkArgs(def, args);
      if (bad) throw new Error(bad);
      const out = def.run ? await def.run(args, get, post) : await hit(def.route[0], def.route[1], args);
      if (!def.task) finish(callId, "done", { result: out });
      else {
        // Tác vụ nền: kết quả thật đến ở sự kiện "end" của tasks.mjs.
        pending.set(out.task_id, { callId, def, args });
        markTask(callId, out.queued ? "queued" : "running", out.task_id, { queued: Boolean(out.queued), position: out.position || 0, note: `Đang chạy nền. Gọi get_call với call_id=${callId} (thêm wait_sec để chờ) để lấy kết quả.` });
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
