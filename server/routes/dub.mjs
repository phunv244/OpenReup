/** Lồng tiếng: bắt đầu, câu thoại, xuất lại, gán dự án, dọn cache, xóa. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_VOICE, DUBBED_DIR, DUB_WORK_DIR, ROOT, VENV_PYTHON } from "../config.mjs";
import { db, inTransaction } from "../lib/db.mjs";
import { loadDubProject, readDubbed, removeDubJob, saveDubProject, updateDubbed } from "../lib/store.mjs";
import { dubBusyError, spawnTask, task } from "../lib/tasks.mjs";
import { fail, resolveDownload, safeJobId, validDelogo, validModelId, validVoice } from "../lib/util.mjs";

const dubPy = path.join(ROOT, "dub_video.py");
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function dubRoutes(app) {
  app.get("/api/dubbed", async () => {
    const videos = readDubbed().filter((v) => v.mp4_file && fs.existsSync(path.join(DUBBED_DIR, v.mp4_file)));
    return { total: videos.length, videos };
  });

  app.post("/api/dub/start", async (req, reply) => {
    const body = req.body || {};
    const rel = String(body.rel_path || "");
    const resolved = resolveDownload(rel);
    if (!resolved || resolved.startsWith(DUBBED_DIR + path.sep) || !fs.existsSync(resolved)) {
      return fail(reply, 400, "File video nguồn không hợp lệ.");
    }
    if (body.delogo !== undefined && !validDelogo(body.delogo)) return fail(reply, 400, "Vùng xóa logo không hợp lệ.");
    if (body.voice && !validVoice(body.voice)) return fail(reply, 400, "Giọng đọc không hợp lệ.");
    if (body.model && !validModelId(body.model)) return fail(reply, 400, "Mô hình nhận diện không hợp lệ.");
    if (!fs.existsSync(VENV_PYTHON)) return fail(reply, 500, "Chưa cài môi trường Python (.venv). Xem mục Cài đặt trong README.");
    const args = [
      "-u", dubPy,
      "--input", resolved,
      "--speed", String(Number(body.speed) || 0.5),
      "--voice", String(body.voice || DEFAULT_VOICE),
      "--model", String(body.model || "sensevoice-small"),
      "--bg-volume", String(Number(body.bg_volume ?? 0.05) || 0),
      "--delogo", String(body.delogo || "none"),
    ];
    if (body.burn_sub === false) args.push("--no-sub");
    if (body.multi_voice) args.push("--multi-voice");
    if (body.project_id) args.push("--story-project", String(body.project_id));
    if (body.fresh) args.push("--fresh");
    return send(reply, spawnTask("dub_video", VENV_PYTHON, args, rel));
  });

  // Phụ đề phân trang (video 90 tiếng có >100k câu)
  app.get("/api/dub/segments", async (req, reply) => {
    const qs = req.query;
    const jobId = safeJobId(qs.id);
    const proj = loadDubProject(jobId);
    if (!proj) return fail(reply, 404, "Không tìm thấy dữ liệu phụ đề của bản lồng tiếng này.");
    const q = String(qs.q || "").trim().toLowerCase();
    const where = ["job_id = ?"];
    const params = [jobId];
    if (qs.only === "empty") where.push("vi = ''");
    if (q) {
      where.push("(instr(lc(vi), ?) > 0 OR instr(zh, ?) > 0)");
      params.push(q, q);
    }
    const offset = Math.max(0, Number(qs.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(qs.limit) || 100));
    const totals = db.prepare("SELECT count(*) AS total, coalesce(sum(vi = ''), 0) AS empty FROM segments WHERE job_id = ?").get(jobId);
    const matched = db.prepare(`SELECT count(*) AS n FROM segments WHERE ${where.join(" AND ")}`).get(...params).n;
    const items = db
      .prepare(`SELECT id, start_s AS start, end_s AS "end", zh, vi, speaker FROM segments WHERE ${where.join(" AND ")} ORDER BY start_s, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { ...proj, total: totals.total, empty: totals.empty, matched, offset, items };
  });

  app.post("/api/dub/rerender", async (req, reply) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const proj = loadDubProject(jobId);
    if (!proj) return fail(reply, 404, "Không tìm thấy project để xuất lại.");
    // Đang có tác vụ lồng tiếng thì không ghi đè câu thoại (tiến trình đó có thể đang đọc/ghi cùng job).
    if (task.proc && task.type.startsWith("dub_")) return fail(reply, 409, `Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.`);
    // Kiểm tra hết trước khi ghi: không để lại thay đổi dở dang khi một phần dữ liệu gửi lên bị sai.
    const edits = body.edits && typeof body.edits === "object" ? body.edits : {};
    const speakers = proj.speakers || {};
    const spkVoices = body.speaker_voices && typeof body.speaker_voices === "object" ? body.speaker_voices : {};
    const spkEdits = body.speaker_edits && typeof body.speaker_edits === "object" ? body.speaker_edits : {};
    const bad =
      (body.voice && !validVoice(body.voice) && "Giọng đọc không hợp lệ.") ||
      (body.delogo !== undefined && !validDelogo(body.delogo) && "Vùng xóa logo không hợp lệ.") ||
      (Object.entries(spkVoices).some(([spk, v]) => !speakers[spk] || !validVoice(v)) && "Giọng nhân vật không hợp lệ.") ||
      (Object.values(spkEdits).some((spk) => !speakers[spk]) && "Nhân vật không hợp lệ.");
    if (bad) return fail(reply, 400, bad);
    // Chỉ nhận các câu đã sửa {id: lời mới} / {id: "NV2"} — không gửi lại cả trăm nghìn câu.
    const setVi = db.prepare("UPDATE segments SET vi = ? WHERE job_id = ? AND id = ?");
    const setSpk = db.prepare("UPDATE segments SET speaker = ? WHERE job_id = ? AND id = ?");
    inTransaction(() => {
      for (const [id, vi] of Object.entries(edits)) setVi.run(String(vi).trim(), jobId, Number(id) || 0);
      for (const [id, spk] of Object.entries(spkEdits)) setSpk.run(String(spk), jobId, Number(id) || 0);
    });
    for (const [spk, v] of Object.entries(spkVoices)) speakers[spk].voice = String(v);
    if (body.voice) proj.voice = String(body.voice);
    if (body.bg_volume !== undefined) proj.bg_volume = Number(body.bg_volume) || 0;
    if (body.burn_sub !== undefined) proj.burn_sub = Boolean(body.burn_sub);
    if (body.delogo !== undefined) proj.delogo = String(body.delogo);
    saveDubProject(jobId, proj);
    return send(reply, spawnTask("dub_rerender", VENV_PYTHON, ["-u", dubPy, "--project", jobId], jobId));
  });

  app.post("/api/dub/assign", async (req) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const projectId = String(body.project_id || "").trim();
    updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.project_id = projectId)));
    const proj = loadDubProject(jobId);
    if (proj) {
      proj.project_id = projectId;
      saveDubProject(jobId, proj);
    }
    return { ok: true };
  });

  // Xóa cache (giọng đọc + các phần video đã mã hóa) để lấy lại ổ cứng; bản lồng tiếng vẫn giữ nguyên.
  app.post("/api/dub/clean", async (req, reply) => {
    const jobId = safeJobId(req.body?.job_id);
    if (dubBusyError()) return fail(reply, 409, dubBusyError());
    if (jobId) fs.rmSync(path.join(DUB_WORK_DIR, jobId), { recursive: true, force: true });
    updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.cache_mb = 0)));
    return { ok: true };
  });

  app.post("/api/dub/delete", async (req, reply) => {
    const jobId = safeJobId(req.body?.job_id);
    if (!jobId) return fail(reply, 400, "Thiếu job_id.");
    if (dubBusyError()) return fail(reply, 409, dubBusyError());
    removeDubJob(jobId);
    return { ok: true };
  });
}
