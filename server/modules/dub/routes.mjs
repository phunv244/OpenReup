/** HTTP của module dub (đường dẫn API giữ như cũ). Chỉ đọc request / trả response; nghiệp vụ ở editor.mjs và service.mjs. */
import { safeJobId } from "../../lib/util.mjs";
import { taskEvents } from "../../lib/tasks.mjs";
import { createDubEditor } from "./editor.mjs";

/** Kết quả spawnTask: {ok:false} (hàng đợi đầy, trùng tác vụ) → 409. */
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function dubRoutes(app, ctx, dub) {
  const editor = createDubEditor(dub, ctx.get("ai").validModel, (fn) => ctx.listen(taskEvents, "end", fn));

  app.get("/api/dubbed", async () => editor.dubbed());

  app.post("/api/dub/start", async (req, reply) => send(reply, editor.start(req.body || {})));
  app.get("/api/dub/segments", async (req) => editor.segments(safeJobId(req.query.id), req.query));
  app.get("/api/dub/outline", async (req) => editor.outline(safeJobId(req.query.id)));
  app.post("/api/dub/rerender", async (req, reply) => send(reply, editor.rerender(safeJobId(req.body?.job_id), req.body || {})));
  app.post("/api/dub/segment/update", async (req) => editor.updateSegment(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/split", async (req) => editor.splitSegment(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/merge", async (req) => editor.mergeSegments(safeJobId(req.body?.job_id), req.body || {}));
  app.post("/api/dub/segment/delete", async (req) => editor.deleteSegment(safeJobId(req.body?.job_id), req.body || {}));

  app.post("/api/dub/assign", async (req) => editor.assign(safeJobId(req.body?.job_id), req.body?.project_id));
  app.post("/api/dub/clean", async (req) => editor.clean(safeJobId(req.body?.job_id)));

  app.post("/api/dub/delete", async (req) => editor.remove(safeJobId(req.body?.job_id)));
}
