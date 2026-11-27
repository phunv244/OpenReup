/**
 * Module sources: video nguồn (quét/tải Douyin, tải Bilibili/YouTube, xóa logo, danh sách downloads/, gán dự án, xóa).
 * Phụ thuộc: dub (job lồng tiếng của video nguồn: hiện trạng thái, xóa job dở khi xóa video), project (kiểm dự án tồn tại khi gán).
 * Service cho module khác (ctx.get("sources")): list(), fileOf(rel), assign(rel, projectId), remove(body).
 */
import { spawnTask, task } from "../../lib/tasks.mjs";
import { SOURCE_FUNCTIONS } from "./functions.mjs";
import { sourceRepo } from "./repo.mjs";
import sourceRoutes from "./routes.mjs";
import { createSourceService } from "./service.mjs";

const tasks = { spawnTask, running: () => (task.proc ? task : null) };

export default {
  name: "sources",
  deps: ["dub", "project"],
  init: (ctx) => createSourceService(sourceRepo, { dub: ctx.get("dub"), project: ctx.get("project"), tasks }),
  routes: sourceRoutes,
  functions: SOURCE_FUNCTIONS,
};
