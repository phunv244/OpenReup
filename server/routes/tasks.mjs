/** Tiến trình nền, hàng đợi, thông tin máy. */
import fs from "node:fs";
import { ROOT } from "../config.mjs";
import { removeQueued, stopTask, taskSnapshot } from "../lib/tasks.mjs";

export default async function taskRoutes(app) {
  app.get("/api/task", async () => taskSnapshot());

  app.post("/api/task/queue/remove", async (req) => ({ ok: removeQueued(req.body?.id) }));

  app.post("/api/task/stop", async () => {
    stopTask();
    return { ok: true };
  });

  app.get("/api/system", async () => {
    let freeGb = 0;
    let totalGb = 0;
    try {
      const st = fs.statfsSync(ROOT);
      freeGb = Number(((st.bavail * st.bsize) / 1024 ** 3).toFixed(1));
      totalGb = Number(((st.blocks * st.bsize) / 1024 ** 3).toFixed(1));
    } catch {}
    return { free_gb: freeGb, total_gb: totalGb };
  });
}
