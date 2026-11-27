/** Nghiệp vụ module Threads: VideoThreads (chữ/ảnh) & ReupThreads (video), dùng chung 1 GPU queue spawnTask. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, THREADS_CLI, THREADS_DIR } from "../../config.mjs";
import { spawnTask } from "../../lib/tasks.mjs";
import { httpError, relOf, validDelogo, validSubcover, validVoice } from "../../lib/util.mjs";

const THREADS_URL_RE = /^https:\/\/(?:www\.)?threads\.(?:net|com)\/(?:@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+|t\/[A-Za-z0-9_-]+)\/?(?:\?.*)?$/i;
const SAFE_FONT_NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

export function validateFontNameStr(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  const clean = String(raw).trim();
  if (!SAFE_FONT_NAME_RE.test(clean)) {
    throw httpError(
      400,
      "ERR_VALIDATION_FAILED: font_name không hợp lệ (chỉ cho phép ký tự A-Z, a-z, 0-9, khoảng trắng, _, ., - và tối đa 64 ký tự).",
    );
  }
  return clean;
}

export function validateThreadsUrlStr(url) {
  const clean = String(url || "").trim();
  if (!clean || !THREADS_URL_RE.test(clean)) {
    throw httpError(
      400,
      "ERR_INVALID_URL: Đường dẫn bài viết Threads không hợp lệ (dạng https://www.threads.net/@user/post/xyz).",
    );
  }
  return clean;
}

export function validateOriginalAudioVolumePct(raw) {
  if (raw === undefined || raw === null || raw === "") return 20;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 200) {
    throw httpError(
      400,
      `ERR_VALIDATION_FAILED: originalAudioVolumePct phải là số trong khoảng 0–200 (nhận ${String(raw)}).`,
    );
  }
  return n;
}

function makeJobId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function extractResultFromLogs(logs) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = String(logs[i] || "");
    const idx = line.indexOf("@@RESULT ");
    if (idx >= 0) {
      try {
        return JSON.parse(line.slice(idx + 9));
      } catch {}
    }
  }
  return null;
}

export function createThreadsService(repo, { validAgyModel, onTaskEnd }) {
  const pendingByTaskId = new Map();

  onTaskEnd?.((ev) => {
    const jobId = pendingByTaskId.get(ev.task_id);
    if (!jobId) return;
    pendingByTaskId.delete(ev.task_id);
    const parsed = extractResultFromLogs(ev.logs || []);
    const saved = Array.isArray(ev.saved_files) && ev.saved_files.length ? relOf(ev.saved_files[0]) : "";
    if (ev.exit_code === 0 && (!parsed || parsed.ok !== false)) {
      repo.update(jobId, {
        status: "done",
        result: parsed?.data ?? parsed ?? {},
        output_rel_path: saved,
        error: "",
      });
    } else {
      const stopped = ev.exit_code === null || ev.exit_code === 130;
      const errMsg =
        parsed?.error?.message ||
        (stopped ? "Tác vụ đã bị dừng." : `Tiến trình thoát với mã ${ev.exit_code}.`);
      repo.update(jobId, {
        status: stopped ? "stopped" : "error",
        result: parsed ?? {},
        error: errMsg,
      });
    }
  });

  function ensureCli() {
    if (!fs.existsSync(THREADS_CLI)) {
      throw httpError(
        500,
        "Chưa build packages/threads (thiếu packages/threads/dist/cli.js). Chạy: npm --prefix packages/threads run build.",
      );
    }
  }

  return {
    listJobs: (limit) => repo.list(limit),

    getJob: (id) => {
      const job = repo.get(id);
      if (!job) throw httpError(404, `Không tìm thấy job Threads "${id}".`);
      return job;
    },

    deleteJob: (id) => {
      if (!repo.remove(id)) throw httpError(404, `Không tìm thấy job Threads "${id}".`);
      return { ok: true, id };
    },

    startVideoThreads(body = {}) {
      ensureCli();
      const url = validateThreadsUrlStr(body.url);
      if (body.voice && !validVoice(body.voice)) throw httpError(400, "Giọng đọc không hợp lệ.");
      const theme = body.theme === "light" ? "light" : "dark";
      const fps = Number(body.fps) === 30 ? 30 : 60;
      const maxComments = body.max_comments !== undefined ? Number(body.max_comments) : 5;
      if (!Number.isInteger(maxComments) || maxComments < 1 || maxComments > 5) {
        throw httpError(400, "ERR_VALIDATION_FAILED: max_comments phải từ 1 đến 5.");
      }

      fs.mkdirSync(THREADS_DIR, { recursive: true });
      const jobId = makeJobId("vt");
      const outputAbs = path.join(THREADS_DIR, `${jobId}.mp4`);
      const previewAbs = path.join(THREADS_DIR, `${jobId}.png`);
      const args = [
        THREADS_CLI,
        "video-threads",
        "--url", url,
        "--job-id", jobId,
        "--theme", theme,
        "--fps", String(fps),
        "--max-comments", String(maxComments),
        "--output", outputAbs,
        "--preview-still", previewAbs,
      ];
      if (body.voice) args.push("--voice", String(body.voice));
      if (body.background_video_path) args.push("--bg-video", String(body.background_video_path));

      const started = spawnTask("threads_video", process.execPath, args, jobId);
      if (!started.ok) return started;
      const job = repo.create({
        id: jobId,
        mode: "video_threads",
        url,
        status: started.queued ? "queued" : "running",
        params: { url, voice: body.voice || "", theme, fps, max_comments: maxComments },
        task_id: started.task_id,
      });
      pendingByTaskId.set(started.task_id, jobId);
      return { ...started, job_id: jobId, job };
    },

    startReupThreads(body = {}) {
      ensureCli();
      const hasUrl = Boolean(String(body.url || "").trim());
      const localVideo = String(body.local_video_path || "").trim();
      if (!hasUrl && !localVideo) {
        throw httpError(400, "ERR_VALIDATION_FAILED: Cần cung cấp url bài viết Threads hoặc local_video_path.");
      }
      const url = hasUrl ? validateThreadsUrlStr(body.url) : "";
      const volPct = validateOriginalAudioVolumePct(
        body.original_audio_volume_pct ?? body.originalAudioVolumePct,
      );
      if (body.voice && !validVoice(body.voice)) throw httpError(400, "Giọng đọc không hợp lệ.");
      if (body.delogo !== undefined && !validDelogo(body.delogo)) throw httpError(400, "Vùng xóa logo không hợp lệ.");
      if (body.subcover !== undefined && !validSubcover(body.subcover)) throw httpError(400, "Vùng che phụ đề gốc không hợp lệ.");
      if (body.agy_model && !validAgyModel(body.agy_model)) throw httpError(400, "Model dịch không hợp lệ.");
      const safeFontName = validateFontNameStr(body.font_name);

      const maxDurationSec = body.max_duration_sec !== undefined ? Number(body.max_duration_sec) : 180;
      if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0 || maxDurationSec > 3600) {
        throw httpError(400, "ERR_VALIDATION_FAILED: max_duration_sec phải trong khoảng 1–3600.");
      }

      fs.mkdirSync(THREADS_DIR, { recursive: true });
      const jobId = makeJobId("rt");
      const outputAbs = path.join(THREADS_DIR, `${jobId}.mp4`);
      const workDir = path.join(DATA_DIR, "threads_work", jobId);
      const burnSub = body.burn_sub !== false;

      const args = [
        THREADS_CLI,
        "reup-threads",
        "--job-id", jobId,
        "--work-dir", workDir,
        "--output", outputAbs,
        "--original-audio-volume-pct", String(volPct),
        "--max-duration-sec", String(maxDurationSec),
        "--burn-sub", burnSub ? "true" : "false",
      ];
      if (url) args.push("--url", url);
      if (localVideo) args.push("--local-video", localVideo);
      if (body.voice) args.push("--voice", String(body.voice));
      if (body.delogo) args.push("--delogo", String(body.delogo));
      if (body.subcover) args.push("--subcover", String(body.subcover));
      if (safeFontName) args.push("--font-name", safeFontName);
      if (body.agy_model) args.push("--agy-model", String(body.agy_model));
      if (body.skip_agy) args.push("--skip-agy", "true");
      if (body.encoder) args.push("--encoder", String(body.encoder));

      const started = spawnTask("threads_reup", process.execPath, args, jobId);
      if (!started.ok) return started;
      const job = repo.create({
        id: jobId,
        mode: "reup_threads",
        url,
        local_video_path: localVideo,
        status: started.queued ? "queued" : "running",
        params: {
          url,
          local_video_path: localVideo,
          voice: body.voice || "",
          original_audio_volume_pct: volPct,
          delogo: body.delogo || "none",
          subcover: body.subcover || "none",
          burn_sub: burnSub,
          agy_model: body.agy_model || "",
          max_duration_sec: maxDurationSec,
        },
        task_id: started.task_id,
      });
      pendingByTaskId.set(started.task_id, jobId);
      return { ...started, job_id: jobId, job };
    },

    scrapePost(body = {}) {
      ensureCli();
      const url = validateThreadsUrlStr(body.url);
      const jobId = makeJobId("sc");
      const args = [THREADS_CLI, "scrape", "--url", url, "--job-id", jobId];
      if (body.bypass_cache) args.push("--bypass-cache", "true");
      const started = spawnTask("threads_scrape", process.execPath, args, jobId);
      if (!started.ok) return started;
      const job = repo.create({
        id: jobId,
        mode: "scrape",
        url,
        status: started.queued ? "queued" : "running",
        params: { url, bypass_cache: Boolean(body.bypass_cache) },
        task_id: started.task_id,
      });
      pendingByTaskId.set(started.task_id, jobId);
      return { ...started, job_id: jobId, job };
    },
  };
}
