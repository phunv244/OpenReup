/** HTTP của module dub (đường dẫn API giữ như cũ). Chỉ đọc request / trả response; nghiệp vụ ở editor.mjs và service.mjs. */
import fs from "node:fs";
import { fail, safeJobId } from "../../lib/util.mjs";
import { lookupDownload } from "../../lib/videos.mjs";
import { createDubEditor } from "./editor.mjs";
import { updateDubbed, loadDubProject, saveDubProject } from "./repo.mjs";

/** Kết quả spawnTask: {ok:false} (hàng đợi đầy, trùng tác vụ) → 409. */
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function dubRoutes(app, ctx, dub) {
  const editor = createDubEditor(dub, ctx.get("ai").validModel);

  app.get("/api/dubbed", async () => {
    const videos = dub.list().filter((v) => {
      const abs = v.mp4_file && lookupDownload(`downloads/dubbed/${v.mp4_file}`)?.abs;
      return abs && fs.existsSync(abs);
    });
    return { total: videos.length, videos };
  });

  app.post("/api/dub/start", async (req, reply) => send(reply, editor.start(req.body || {})));
  app.get("/api/dub/segments", async (req) => editor.segments(safeJobId(req.query.id), req.query));
  app.get("/api/dub/outline", async (req) => editor.outline(safeJobId(req.query.id)));
  app.post("/api/dub/rerender", async (req, reply) => send(reply, editor.rerender(safeJobId(req.body?.job_id), req.body || {})));
  app.post("/api/dub/segment/update", async (req) => editor.updateSegment(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/split", async (req) => editor.splitSegment(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/merge", async (req) => editor.mergeSegments(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/delete", async (req) => editor.deleteSegment(safeJobId(req.body?.job_id), req.body || {}));

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
    if (dub.busyError()) return fail(reply, 409, dub.busyError());
    if (jobId) dub.removeWorkDir(jobId);
    updateDubbed((vids) => vids.forEach((v) => v.job_id === jobId && (v.cache_mb = 0)));
    return { ok: true };
  });

  app.post("/api/dub/delete", async (req, reply) => {
    const jobId = safeJobId(req.body?.job_id);
    if (!jobId) return fail(reply, 400, "Thiếu job_id.");
    if (dub.busyError()) return fail(reply, 409, dub.busyError());
    dub.removeJob(jobId);
    return { ok: true };
  });
}
