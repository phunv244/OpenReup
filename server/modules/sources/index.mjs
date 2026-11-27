/**
 * Module sources: video nguồn (quét/tải Douyin, tải Bilibili/YouTube, xóa logo, danh sách downloads/, gán dự án, xóa).
 * Phụ thuộc: dub (job lồng tiếng của video nguồn: hiện trạng thái, xóa job dở khi xóa video), project (kiểm dự án tồn tại khi gán).
 * Service cho module khác (ctx.get("sources")): list(), fileOf(rel), assign(rel, projectId), remove(body).
 */
import { spawnTask, task, taskEvents } from "../../lib/tasks.mjs";
import { SOURCE_FUNCTIONS } from "./functions.mjs";
import { sourceRepo } from "./repo.mjs";
import sourceRoutes from "./routes.mjs";
import { createSourceService } from "./service.mjs";

const tasks = { spawnTask, running: () => (task.proc ? task : null) };

export default {
  name: "sources",
  deps: ["dub", "project"],
  init(ctx) {
    const project = ctx.get("project");
    // File tải xong khi bấm tải trong 1 dự án (lib/tasks báo theo dòng SAVED_FILE::: của script tải) → gán vào dự án đó.
    ctx.listen(taskEvents, "saved_file", ({ rel, project_id }) => project.setVideoOwner(rel, project_id));
    return createSourceService(sourceRepo, { dub: ctx.get("dub"), project, tasks });
  },
  routes: sourceRoutes,
  functions: SOURCE_FUNCTIONS,
};
