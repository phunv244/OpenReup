/** HTTP của module tasks (đường dẫn API giữ như cũ): tiến trình nền, hàng đợi, thông tin máy. */
import { removeQueued, stopTask, taskSnapshot } from "../../lib/tasks.mjs";

export default async function taskRoutes(app, ctx, tasks) {
  app.get("/api/task", async () => taskSnapshot());
  app.post("/api/task/queue/remove", async (req) => ({ ok: removeQueued(req.body?.id) }));
  app.post("/api/task/stop", async () => {
    stopTask();
    return { ok: true };
  });
  app.get("/api/system", async () => tasks.disk());
}
