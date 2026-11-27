/**
 * Module threads: VideoThreads (chữ/ảnh -> video 9:16 Remotion) & ReupThreads (reup video Threads 6 bước + DSP 0–200%).
 * Dùng chung 1 GPU queue (spawnTask) và SQLite WAL (data/openreup.db), không dùng sidecar :23334.
 */
import { taskEvents } from "../../lib/tasks.mjs";
import { THREADS_FUNCTIONS } from "./functions.mjs";
import { threadsRepo } from "./repo.mjs";
import threadsRoutes from "./routes.mjs";
import { createThreadsService } from "./service.mjs";

export default {
  name: "threads",
  deps: ["ai"],
  init: (ctx) =>
    createThreadsService(threadsRepo, {
      validAgyModel: ctx.get("ai").validModel,
      onTaskEnd: (fn) => ctx.listen(taskEvents, "end", fn),
    }),
  routes: threadsRoutes,
  functions: THREADS_FUNCTIONS,
};
