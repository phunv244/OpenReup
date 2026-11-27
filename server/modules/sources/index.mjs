/**
 * Module sources: video nguồn (quét/tải Douyin, tải Bilibili/YouTube, xóa logo, danh sách downloads/, gán dự án, xóa).
 * Phụ thuộc: dub (job lồng tiếng của video nguồn: hiện trạng thái, xóa job dở khi xóa video), project (kiểm dự án tồn tại khi gán).
 * Service cho module khác (ctx.get("sources")): list(), fileOf(rel), assign(rel, projectId, move), remove(body).
 */
import { spawnTask, task, taskEvents, taskLog } from "../../lib/tasks.mjs";
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
    // File đã có sẵn và thuộc dự án khác: giữ dự án cũ, ghi lý do vào nhật ký tác vụ (không lặng lẽ chuyển).
    ctx.listen(taskEvents, "saved_file", ({ rel, project_id }) => {
      try {
        project.assignVideo(rel, project_id);
      } catch (err) {
        if (err.statusCode !== 409) throw err;
        taskLog(`Không gán ${rel} vào dự án đang mở: ${err.message}`);
      }
    });
    return createSourceService(sourceRepo, { dub: ctx.get("dub"), project, tasks });
  },
  routes: sourceRoutes,
  functions: SOURCE_FUNCTIONS,
};
