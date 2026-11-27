/**
 * Nghiệp vụ tác vụ lồng tiếng: bắt đầu lồng tiếng 1 video nguồn, đọc câu thoại, sửa / cắt / ghép / xóa câu trên timeline, xuất lại.
 * Lỗi do input: ném httpError (error handler của app trả {ok:false, error}).
 */
import fs from "node:fs";
import { DEFAULT_VOICE, PY_SCRIPTS, VENV_PYTHON } from "../../config.mjs";
import { checkSubStyle } from "../../lib/fonts.mjs";
import { spawnTask, task } from "../../lib/tasks.mjs";
import { httpError, projectIdOf, validDelogo, validModelId, validSubcover, validVoice } from "../../lib/util.mjs";
import { legacyJobFields, lookupDownload } from "../../lib/videos.mjs";
import { loadDubProject, saveDubProject, updateDubbed } from "./repo.mjs";
import { segmentsRepo as seg } from "./segments-repo.mjs";

const OUTLINE_CAP = 4000; // thanh timeline vẽ tối đa ngần này câu đầu; video siêu dài dùng bảng tìm kiếm
const BUSY = "Đang có tiến trình lồng tiếng chạy. Hãy chờ xong hoặc dừng trước.";
const obj = (v) => (v && typeof v === "object" ? v : {});

/** Câu thoại chỉ được sửa khi không có tiến trình lồng tiếng nào (nó có thể đang đọc/ghi cùng job). */
function assertIdle() {
  if (task.proc && task.type.startsWith("dub_")) throw httpError(409, BUSY);
}

/**
 * dub: service của chính module dub (pathArgs, jobIdFor, list, busyError, removeWorkDir); validAgyModel: kiểm id model dịch (service module ai);
 * onTaskEnd(fn): nghe sự kiện tác vụ nền kết thúc (ctx.listen, tự gỡ khi app đóng).
 */
export function createDubEditor(dub, validAgyModel, onTaskEnd) {
  const { pathArgs } = dub;
  // task_id → {jobId, rev} của các lần xuất lại toàn phần đang chạy: xong (exit 0) thì xóa cờ timeline_dirty,
  // trừ khi có sửa mới trong lúc chạy (rev tăng). Lỗi / bị dừng thì giữ cờ.
  const pendingFullRender = new Map();
  onTaskEnd(({ task_id, exit_code }) => {
    const p = pendingFullRender.get(task_id);
    if (!p) return;
    pendingFullRender.delete(task_id);
    if (exit_code === 0) seg.clearDirty(p.jobId, p.rev);
  });

  const projectOr = (jobId, status, msg) => {
    const proj = loadDubProject(jobId);
    if (!proj) throw httpError(status, msg);
    return proj;
  };
  const NO_SUBS = "Không tìm thấy dữ liệu phụ đề của bản lồng tiếng này.";

  return {
    /** Lồng tiếng 1 video nguồn (rel "downloads/..."); bản xuất bị chặn theo loại file. Trả kết quả spawnTask. */
    start(body) {
      const rel = String(body.rel_path || "");
      const hit = lookupDownload(rel);
      const input = hit?.kind === "source" ? hit.abs : "";
      if (!input || !fs.existsSync(input)) throw httpError(400, "File video nguồn không hợp lệ.");
      if (body.delogo !== undefined && !validDelogo(body.delogo)) throw httpError(400, "Vùng xóa logo không hợp lệ.");
      if (body.subcover !== undefined && !validSubcover(body.subcover)) throw httpError(400, "Vùng che phụ đề gốc không hợp lệ.");
      if (body.voice && !validVoice(body.voice)) throw httpError(400, "Giọng đọc không hợp lệ.");
      if (body.model && !validModelId(body.model)) throw httpError(400, "Mô hình nhận diện không hợp lệ.");
      if (body.agy_model && !validAgyModel(body.agy_model)) throw httpError(400, "Model dịch không hợp lệ.");
      const subStyle = checkSubStyle(body.sub_style);
      if (subStyle.error) throw httpError(400, subStyle.error);
      if (!fs.existsSync(VENV_PYTHON)) throw httpError(500, "Chưa cài môi trường Python (.venv). Xem mục Cài đặt trong README.");
      const speed = Number(body.speed) || 0.5;
      const args = [
        "-u", PY_SCRIPTS.dub,
        "--input", input,
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
      args.push(...pathArgs(dub.jobIdFor(input, speed)));
      return spawnTask("dub_video", VENV_PYTHON, args, rel);
    },

    /** Phụ đề phân trang (video 90 tiếng có >100k câu). */
    segments(jobId, qs) {
      const proj = projectOr(jobId, 404, NO_SUBS);
      const offset = Math.max(0, Number(qs.offset) || 0);
      const limit = Math.min(500, Math.max(1, Number(qs.limit) || 100));
      const text = String(qs.q || "").trim().toLowerCase();
      const page = seg.page(jobId, { onlyEmpty: qs.only === "empty", text, limit, offset });
      return { ...legacyJobFields(jobId, proj), total: page.total, empty: page.empty, matched: page.matched, offset, items: page.items, timeline_dirty: seg.dirtyRev(jobId) > 0 };
    },

    outline(jobId) {
      projectOr(jobId, 404, NO_SUBS);
      const total = seg.count(jobId);
      return { total, truncated: total > OUTLINE_CAP, items: seg.firstN(jobId, OUTLINE_CAP) };
    },

    /** Lưu câu đã sửa + cấu hình, rồi xuất lại ở mức tối thiểu. Trả kết quả spawnTask ({ok, task_id} | {ok:false, error}). */
    rerender(jobId, body) {
      const proj = projectOr(jobId, 404, "Không tìm thấy project để xuất lại.");
      assertIdle();
      // Kiểm tra hết trước khi ghi: không để lại thay đổi dở dang khi một phần dữ liệu gửi lên bị sai.
      const edits = obj(body.edits);
      const speakers = proj.speakers || {};
      const spkVoices = obj(body.speaker_voices);
      const spkEdits = obj(body.speaker_edits);
      const subStyle = checkSubStyle(body.sub_style);
      const bad =
        subStyle.error ||
        (body.voice && !validVoice(body.voice) && "Giọng đọc không hợp lệ.") ||
        (body.delogo !== undefined && !validDelogo(body.delogo) && "Vùng xóa logo không hợp lệ.") ||
        (body.subcover !== undefined && !validSubcover(body.subcover) && "Vùng che phụ đề gốc không hợp lệ.") ||
        (Object.entries(spkVoices).some(([spk, v]) => !speakers[spk] || !validVoice(v)) && "Giọng nhân vật không hợp lệ.") ||
        (Object.values(spkEdits).some((spk) => !speakers[spk]) && "Nhân vật không hợp lệ.");
      if (bad) throw httpError(400, bad);
      // Chỉ nhận các câu đã sửa {id: lời mới} / {id: "NV2"} — không gửi lại cả trăm nghìn câu.
      seg.applyEdits(jobId, edits, spkEdits);

      // Mức làm lại tối thiểu: chỉ đổi kiểu/vùng phụ đề thì không dựng lại tiếng, chỉ đổi giọng/âm lượng thì
      // không mã hóa lại hình. Sửa lời mà có in phụ đề thì đổi cả hai.
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
      const dirtyRev = seg.dirtyRev(jobId);
      const only = dirtyRev ? "" : videoChange && !audioChange ? "video" : audioChange && !videoChange ? "audio" : "";

      for (const [spk, v] of Object.entries(spkVoices)) speakers[spk].voice = String(v);
      if (body.voice) proj.voice = String(body.voice);
      if (body.bg_volume !== undefined) proj.bg_volume = Number(body.bg_volume) || 0;
      if (body.burn_sub !== undefined) proj.burn_sub = Boolean(body.burn_sub);
      if (body.delogo !== undefined) proj.delogo = String(body.delogo);
      if (body.subcover !== undefined) proj.subcover = String(body.subcover);
      if (body.sub_style !== undefined) proj.sub_style = subStyle.style; // null = quay về kiểu mặc định
      saveDubProject(jobId, proj);

      const args = ["-u", PY_SCRIPTS.dub, "--project", jobId, ...pathArgs(jobId), ...(only ? ["--only", only] : [])];
      const started = spawnTask("dub_rerender", VENV_PYTHON, args, jobId);
      if (started.ok && dirtyRev) pendingFullRender.set(started.task_id, { jobId, rev: dirtyRev });
      return started;
    },

    /** Sửa mốc giờ (kéo mép khối trên timeline) và/hoặc người nói của 1 câu; mốc bị kẹp trong khoảng giữa 2 câu bên cạnh. */
    updateSegment(jobId, body) {
      const id = Number(body.id);
      if (!loadDubProject(jobId) || !Number.isInteger(id)) throw httpError(400, "Thiếu job_id hoặc id câu.");
      assertIdle();
      const row = seg.get(jobId, id);
      if (!row) throw httpError(404, "Không tìm thấy câu này.");
      let start = body.start !== undefined ? Number(body.start) : row.start_s;
      let end = body.end !== undefined ? Number(body.end) : row.end_s;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw httpError(400, "Mốc giờ không hợp lệ.");
      const prevEnd = seg.prevEnd(jobId, row.start_s);
      const nextStart = seg.nextStart(jobId, row.start_s);
      if (prevEnd !== undefined && start < prevEnd) start = prevEnd;
      if (nextStart !== undefined && end > nextStart) end = nextStart;
      if (end <= start) throw httpError(400, "Khoảng thời gian chạm vào câu bên cạnh.");
      seg.setSpan(jobId, id, start, end, body.speaker);
      return { ok: true, id, start, end };
    },

    /** Cắt 1 câu làm 2 tại mốc `at`: câu đầu giữ lời cũ, câu sau để trống cho người dùng gõ lại. */
    splitSegment(jobId, body) {
      const id = Number(body.id);
      const at = Number(body.at);
      if (!loadDubProject(jobId) || !Number.isInteger(id) || !Number.isFinite(at)) throw httpError(400, "Thiếu tham số.");
      assertIdle();
      const row = seg.get(jobId, id);
      if (!row) throw httpError(404, "Không tìm thấy câu này.");
      if (at <= row.start_s + 0.05 || at >= row.end_s - 0.05) throw httpError(400, "Mốc cắt phải nằm giữa câu, cách 2 đầu ít nhất 0,05 giây.");
      return { ok: true, first_id: id, second_id: seg.split(jobId, row, at), at };
    },

    /** Nhập 2 câu liền kề làm 1 (ghép lời Trung + Việt, giữ người nói của câu trước). */
    mergeSegments(jobId, body) {
      const id = Number(body.id);
      const withId = Number(body.with_id);
      if (!loadDubProject(jobId) || !Number.isInteger(id) || !Number.isInteger(withId)) throw httpError(400, "Thiếu tham số.");
      assertIdle();
      const a = seg.get(jobId, id);
      const b = seg.get(jobId, withId);
      if (!a || !b) throw httpError(404, "Không tìm thấy câu cần ghép.");
      if (a.id === b.id) throw httpError(400, "Không thể ghép một câu với chính nó.");
      const [first, second] = a.start_s < b.start_s || (a.start_s === b.start_s && a.id < b.id) ? [a, b] : [b, a];
      // Chỉ ghép 2 câu đứng sát nhau theo thứ tự timeline — ghép câu cách xa sẽ đè lên các câu ở giữa.
      const between = seg.countBetween(jobId, first, second);
      if (between) throw httpError(400, `Chỉ ghép được 2 câu liền kề (đang có ${between} câu nằm giữa).`);
      seg.merge(jobId, first, second);
      return { ok: true, id: first.id };
    },

    /** Xóa 1 câu khỏi timeline (đoạn hình/tiếng không bị xóa — chỉ bỏ dòng này khi xuất lại). */
    deleteSegment(jobId, body) {
      const id = Number(body.id);
      if (!loadDubProject(jobId) || !Number.isInteger(id)) throw httpError(400, "Thiếu tham số.");
      assertIdle();
      if (!seg.remove(jobId, id)) throw httpError(404, "Không tìm thấy câu này.");
      return { ok: true };
    },

    /** Bản lồng tiếng còn file .mp4 trên đĩa (bản mất file xuất không hiện trong danh sách). */
    dubbed() {
      const videos = dub.list().filter((v) => {
        const abs = v.mp4_file && lookupDownload(`downloads/dubbed/${v.mp4_file}`)?.abs;
        return abs && fs.existsSync(abs);
      });
      return { total: videos.length, videos };
    },

    /** Gán bản lồng tiếng vào dự án (projectId rỗng = gỡ khỏi dự án). Dự án phải có thật, như sources.assign. */
    assign(jobId, projectId) {
      if (!jobId) throw httpError(400, "Thiếu job_id.");
      const pid = String(projectId || "").trim();
      if (pid && projectIdOf({ project_id: pid }) !== pid) throw httpError(404, "Không tìm thấy dự án.");
      const proj = loadDubProject(jobId);
      if (!proj && !dub.list().some((v) => v.job_id === jobId)) throw httpError(404, "Không tìm thấy bản lồng tiếng.");
      updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.project_id = pid)));
      if (proj) {
        proj.project_id = pid;
        saveDubProject(jobId, proj);
      }
      return { ok: true };
    },

    /** Xóa cache (giọng đọc + các phần video đã mã hóa) để lấy lại ổ cứng; bản lồng tiếng vẫn giữ nguyên. */
    clean(jobId) {
      if (!jobId) throw httpError(400, "Thiếu job_id.");
      if (dub.busyError()) throw httpError(409, dub.busyError());
      dub.removeWorkDir(jobId);
      updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.cache_mb = 0)));
      return { ok: true };
    },

    /** Xóa hẳn 1 bản lồng tiếng (file xuất + dữ liệu câu thoại). */
    remove(jobId) {
      if (!jobId) throw httpError(400, "Thiếu job_id.");
      if (dub.busyError()) throw httpError(409, dub.busyError());
      dub.removeJob(jobId);
      return { ok: true };
    },
  };
}
