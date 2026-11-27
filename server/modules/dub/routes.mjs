/** HTTP của module dub (đường dẫn API giữ như cũ): bắt đầu, câu thoại, xuất lại, gán dự án, dọn cache, xóa. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_VOICE, DUBBED_DIR, ROOT, VENV_PYTHON } from "../../config.mjs";
import { db, inTransaction } from "../../lib/db.mjs";
import { checkSubStyle } from "../../lib/fonts.mjs";
import { dubBusyError, spawnTask, task, taskEvents } from "../../lib/tasks.mjs";
import { fail, resolveDownload, safeJobId, validDelogo, validModelId, validSubcover, validVoice } from "../../lib/util.mjs";
import { dubRepo } from "./repo.mjs";

const { removeDubWorkDir, loadDubProject, removeDubJob, saveDubProject, updateDubbed } = dubRepo;

const dubPy = path.join(ROOT, "dub_video.py");
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

// Cờ "timeline đã đổi" (bảng timeline_dirty): đặt sau mỗi lần split/merge/delete/update câu, xóa khi lần xuất lại toàn phần chạy xong.
const markTimelineDirty = (jobId) =>
  db.prepare("INSERT INTO timeline_dirty (job_id, rev) VALUES (?, 1) ON CONFLICT(job_id) DO UPDATE SET rev = rev + 1").run(jobId);
const timelineRev = (jobId) => db.prepare("SELECT rev FROM timeline_dirty WHERE job_id = ?").get(jobId)?.rev ?? 0;
// task_id → {jobId, rev} của các lần xuất lại toàn phần đang chờ kết thúc.
const pendingFullRender = new Map();
taskEvents.on("end", ({ task_id, exit_code }) => {
  const p = pendingFullRender.get(task_id);
  if (!p) return;
  pendingFullRender.delete(task_id);
  // Lỗi/bị dừng thì giữ cờ; có sửa mới trong lúc chạy (rev tăng) thì cũng giữ.
  if (exit_code === 0) db.prepare("DELETE FROM timeline_dirty WHERE job_id = ? AND rev <= ?").run(p.jobId, p.rev);
});

export default async function dubRoutes(app, ctx, dub) {
  const ai = ctx.get("ai");
  app.get("/api/dubbed", async () => {
    const videos = dub.list().filter((v) => v.mp4_file && fs.existsSync(path.join(DUBBED_DIR, v.mp4_file)));
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
    if (body.subcover !== undefined && !validSubcover(body.subcover)) return fail(reply, 400, "Vùng che phụ đề gốc không hợp lệ.");
    if (body.voice && !validVoice(body.voice)) return fail(reply, 400, "Giọng đọc không hợp lệ.");
    if (body.model && !validModelId(body.model)) return fail(reply, 400, "Mô hình nhận diện không hợp lệ.");
    if (body.agy_model && !ai.validModel(body.agy_model)) return fail(reply, 400, "Model dịch không hợp lệ.");
    const subStyle = checkSubStyle(body.sub_style);
    if (subStyle.error) return fail(reply, 400, subStyle.error);
    if (!fs.existsSync(VENV_PYTHON)) return fail(reply, 500, "Chưa cài môi trường Python (.venv). Xem mục Cài đặt trong README.");
    const speed = Number(body.speed) || 0.5;
    const args = [
      "-u", dubPy,
      "--input", resolved,
      "--speed", String(speed),
      "--voice", String(body.voice || DEFAULT_VOICE),
      "--model", String(body.model || "sensevoice-small"),
      "--bg-volume", String(Number(body.bg_volume ?? 0.05) || 0),
      "--delogo", String(body.delogo || "none"),
      "--subcover", String(body.subcover || "none"),
    ];
    if (body.agy_model) args.push("--agy-model", String(body.agy_model));
    if (subStyle.style) args.push("--sub-style", JSON.stringify(subStyle.style));
    if (body.burn_sub === false) args.push("--no-sub");
    if (body.multi_voice) args.push("--multi-voice");
    if (body.project_id) args.push("--story-project", String(body.project_id));
    if (body.fresh) args.push("--fresh");
    args.push(...dub.pathArgs(dub.jobIdFor(resolved, speed)));
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
    return { ...proj, total: totals.total, empty: totals.empty, matched, offset, items, timeline_dirty: timelineRev(jobId) > 0 };
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
    const subStyle = checkSubStyle(body.sub_style);
    const bad =
      (subStyle.error) ||
      (body.voice && !validVoice(body.voice) && "Giọng đọc không hợp lệ.") ||
      (body.delogo !== undefined && !validDelogo(body.delogo) && "Vùng xóa logo không hợp lệ.") ||
      (body.subcover !== undefined && !validSubcover(body.subcover) && "Vùng che phụ đề gốc không hợp lệ.") ||
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
    // Chọn mức làm lại tối thiểu theo thứ thay đổi: chỉ đổi kiểu/vùng phụ đề thì không dựng lại tiếng,
    // chỉ đổi giọng/âm lượng thì không mã hóa lại hình. Sửa lời mà có in phụ đề thì đổi cả hai.
    const changed = (k, v) => v !== undefined && JSON.stringify(v) !== JSON.stringify(proj[k] ?? (k === "sub_style" ? null : undefined));
    const editedText = Object.keys(edits).length > 0;
    const videoChange =
      changed("burn_sub", body.burn_sub) || changed("delogo", body.delogo) || changed("subcover", body.subcover) ||
      (body.sub_style !== undefined && JSON.stringify(subStyle.style ?? null) !== JSON.stringify(proj.sub_style ?? null)) ||
      (editedText && proj.burn_sub !== false && body.burn_sub !== false);
    const audioChange =
      editedText || Object.keys(spkEdits).length > 0 ||
      (body.voice && body.voice !== proj.voice) ||
      (body.bg_volume !== undefined && Number(body.bg_volume) !== Number(proj.bg_volume)) ||
      Object.entries(spkVoices).some(([spk, v]) => speakers[spk].voice !== String(v));
    // Timeline đổi (câu bị cắt/ghép/xóa/dời giờ) thì cả phụ đề in lẫn tiếng đều cũ: bắt buộc làm lại toàn bộ.
    const dirtyRev = timelineRev(jobId);
    const only = dirtyRev ? "" : videoChange && !audioChange ? "video" : audioChange && !videoChange ? "audio" : "";
    for (const [spk, v] of Object.entries(spkVoices)) speakers[spk].voice = String(v);
    if (body.voice) proj.voice = String(body.voice);
    if (body.bg_volume !== undefined) proj.bg_volume = Number(body.bg_volume) || 0;
    if (body.burn_sub !== undefined) proj.burn_sub = Boolean(body.burn_sub);
    if (body.delogo !== undefined) proj.delogo = String(body.delogo);
    if (body.subcover !== undefined) proj.subcover = String(body.subcover);
    if (body.sub_style !== undefined) proj.sub_style = subStyle.style; // null = quay về kiểu mặc định
    saveDubProject(jobId, proj);
    const started = spawnTask("dub_rerender", VENV_PYTHON, ["-u", dubPy, "--project", jobId, ...dub.pathArgs(jobId), ...(only ? ["--only", only] : [])], jobId);
    if (started.ok && dirtyRev) pendingFullRender.set(started.task_id, { jobId, rev: dirtyRev });
    return send(reply, started);
  });

  // Toàn bộ câu thoại để vẽ thanh timeline (tối đa 4000 câu đầu — đủ cho video thường, video siêu dài dùng bảng tìm kiếm bên dưới).
  app.get("/api/dub/outline", async (req, reply) => {
    const jobId = safeJobId(req.query.id);
    const proj = loadDubProject(jobId);
    if (!proj) return fail(reply, 404, "Không tìm thấy dữ liệu phụ đề của bản lồng tiếng này.");
    const total = db.prepare("SELECT count(*) AS n FROM segments WHERE job_id = ?").get(jobId).n;
    const CAP = 4000;
    const items = db
      .prepare(`SELECT id, start_s AS start, end_s AS "end", zh, vi, speaker FROM segments WHERE job_id = ? ORDER BY start_s, id LIMIT ?`)
      .all(jobId, CAP);
    return { total, truncated: total > CAP, items };
  });

  // Sửa mốc giờ (kéo mép khối trên timeline) hoặc người nói của 1 câu — ghi ngay, chưa cần "Lưu & xuất lại" mới thấy trên timeline.
  app.post("/api/dub/segment/update", async (req, reply) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const id = Number(body.id);
    const proj = loadDubProject(jobId);
    if (!proj || !Number.isInteger(id)) return fail(reply, 400, "Thiếu job_id hoặc id câu.");
    if (task.proc && task.type.startsWith("dub_")) return fail(reply, 409, "Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.");
    const row = db.prepare('SELECT start_s AS start, end_s AS "end" FROM segments WHERE job_id = ? AND id = ?').get(jobId, id);
    if (!row) return fail(reply, 404, "Không tìm thấy câu này.");
    let start = body.start !== undefined ? Number(body.start) : row.start;
    let end = body.end !== undefined ? Number(body.end) : row.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return fail(reply, 400, "Mốc giờ không hợp lệ.");
    const prev = db.prepare('SELECT end_s AS "end" FROM segments WHERE job_id = ? AND start_s < ? ORDER BY start_s DESC LIMIT 1').get(jobId, row.start);
    const next = db.prepare("SELECT start_s AS start FROM segments WHERE job_id = ? AND start_s > ? ORDER BY start_s ASC LIMIT 1").get(jobId, row.start);
    if (prev && start < prev.end) start = prev.end;
    if (next && end > next.start) end = next.start;
    if (end <= start) return fail(reply, 400, "Khoảng thời gian chạm vào câu bên cạnh.");
    const sets = ["start_s = ?", "end_s = ?"];
    const params = [start, end];
    if (body.speaker !== undefined) {
      sets.push("speaker = ?");
      params.push(String(body.speaker));
    }
    db.prepare(`UPDATE segments SET ${sets.join(", ")} WHERE job_id = ? AND id = ?`).run(...params, jobId, id);
    markTimelineDirty(jobId);
    return { ok: true, id, start, end };
  });

  // Cắt 1 câu làm 2 tại mốc giờ `at` (kéo từ thanh timeline): câu đầu giữ lời cũ, câu sau để trống cho người dùng gõ lại.
  app.post("/api/dub/segment/split", async (req, reply) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const id = Number(body.id);
    const at = Number(body.at);
    const proj = loadDubProject(jobId);
    if (!proj || !Number.isInteger(id) || !Number.isFinite(at)) return fail(reply, 400, "Thiếu tham số.");
    if (task.proc && task.type.startsWith("dub_")) return fail(reply, 409, "Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.");
    const row = db.prepare('SELECT start_s AS start, end_s AS "end", speaker FROM segments WHERE job_id = ? AND id = ?').get(jobId, id);
    if (!row) return fail(reply, 404, "Không tìm thấy câu này.");
    if (at <= row.start + 0.05 || at >= row.end - 0.05) return fail(reply, 400, "Mốc cắt phải nằm giữa câu, cách 2 đầu ít nhất 0,05 giây.");
    const newId = (db.prepare("SELECT max(id) AS m FROM segments WHERE job_id = ?").get(jobId).m || 0) + 1;
    inTransaction(() => {
      db.prepare("UPDATE segments SET end_s = ? WHERE job_id = ? AND id = ?").run(at, jobId, id);
      db.prepare("INSERT INTO segments (job_id, id, start_s, end_s, zh, vi, speaker) VALUES (?, ?, ?, ?, '', '', ?)").run(jobId, newId, at, row.end, row.speaker);
      markTimelineDirty(jobId);
    });
    return { ok: true, first_id: id, second_id: newId, at };
  });

  // Nhập 2 câu liền kề làm 1 (ghép lời Trung + Việt, giữ người nói của câu trước).
  app.post("/api/dub/segment/merge", async (req, reply) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const id = Number(body.id);
    const withId = Number(body.with_id);
    const proj = loadDubProject(jobId);
    if (!proj || !Number.isInteger(id) || !Number.isInteger(withId)) return fail(reply, 400, "Thiếu tham số.");
    if (task.proc && task.type.startsWith("dub_")) return fail(reply, 409, "Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.");
    const a = db.prepare('SELECT * FROM segments WHERE job_id = ? AND id = ?').get(jobId, id);
    const b = db.prepare('SELECT * FROM segments WHERE job_id = ? AND id = ?').get(jobId, withId);
    if (!a || !b) return fail(reply, 404, "Không tìm thấy câu cần ghép.");
    if (a.id === b.id) return fail(reply, 400, "Không thể ghép một câu với chính nó.");
    const [first, second] = a.start_s < b.start_s || (a.start_s === b.start_s && a.id < b.id) ? [a, b] : [b, a];
    // Chỉ ghép 2 câu đứng sát nhau theo thứ tự timeline (start_s, id) — ghép câu cách xa sẽ đè lên các câu ở giữa.
    const between = db
      .prepare("SELECT count(*) AS n FROM segments WHERE job_id = ? AND (start_s, id) > (?, ?) AND (start_s, id) < (?, ?)")
      .get(jobId, first.start_s, first.id, second.start_s, second.id).n;
    if (between) return fail(reply, 400, `Chỉ ghép được 2 câu liền kề (đang có ${between} câu nằm giữa).`);
    inTransaction(() => {
      db.prepare("UPDATE segments SET end_s = ?, zh = ?, vi = ? WHERE job_id = ? AND id = ?").run(
        second.end_s, [first.zh, second.zh].filter(Boolean).join(" "), [first.vi, second.vi].filter(Boolean).join(" "), jobId, first.id
      );
      db.prepare("DELETE FROM segments WHERE job_id = ? AND id = ?").run(jobId, second.id);
      markTimelineDirty(jobId);
    });
    return { ok: true, id: first.id };
  });

  // Xóa 1 câu khỏi timeline (không xóa đoạn hình/tiếng — chỉ bỏ dòng này khi xuất lại).
  app.post("/api/dub/segment/delete", async (req, reply) => {
    const body = req.body || {};
    const jobId = safeJobId(body.job_id);
    const id = Number(body.id);
    const proj = loadDubProject(jobId);
    if (!proj || !Number.isInteger(id)) return fail(reply, 400, "Thiếu tham số.");
    if (task.proc && task.type.startsWith("dub_")) return fail(reply, 409, "Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.");
    const info = db.prepare("DELETE FROM segments WHERE job_id = ? AND id = ?").run(jobId, id);
    if (!info.changes) return fail(reply, 404, "Không tìm thấy câu này.");
    markTimelineDirty(jobId);
    return { ok: true };
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
    if (jobId) removeDubWorkDir(jobId);
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
