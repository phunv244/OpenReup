/**
 * Module dub: lồng tiếng (bắt đầu, câu thoại, xuất lại, gán dự án, dọn cache, xóa).
 * Phụ thuộc: ai (kiểm tra id model dịch agy_model).
 * Service cho module khác (ctx.get("dub")): list(), sources(), unassignProject(id), isProjectBusy(id), pathArgs(jobId), jobIdFor(input, speed),
 *   jobsBySource(), removeWorkDir(jobId), removeJob(jobId), busyError().
 */
import { DUB_FUNCTIONS } from "./functions.mjs";
import { dubRepo } from "./repo.mjs";
import dubRoutes from "./routes.mjs";
import { createDubService } from "./service.mjs";

export default {
  name: "dub",
  deps: ["ai"],
  init: () => createDubService(dubRepo),
  routes: dubRoutes,
  functions: DUB_FUNCTIONS,
};
