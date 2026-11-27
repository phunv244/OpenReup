/**
 * Module resources: tài nguyên dùng chung mọi dự án — font phụ đề, giọng đọc (clone/nghe thử), mô hình nhận diện (ASR + VAD), xem trước phụ đề.
 * Phụ thuộc: ai (list_options đọc /api/agy-models), dub (chặn xóa font/giọng khi đang lồng tiếng), project (thêm/gỡ giọng của dự án), sources (video nguồn đã tải: clone giọng, xem trước phụ đề).
 * Service cho module khác (ctx.get("resources")): fonts(), font(id), voices(), asrModels().
 */
import { VENV_PYTHON } from "../../config.mjs";
import { spawnTask, taskEvents } from "../../lib/tasks.mjs";
import { RESOURCE_FUNCTIONS } from "./functions.mjs";
import { resourceRepo } from "./repo.mjs";
import resourceRoutes from "./routes.mjs";
import { createResourceService } from "./service.mjs";

export default {
  name: "resources",
  deps: ["ai", "dub", "project", "sources"], // ai: list_options đọc /api/agy-models
  init(ctx) {
    resourceRepo.clearVoiceTmp(); // file giọng tải lên dở của lần chạy trước
    return createResourceService(resourceRepo, {
      dub: ctx.get("dub"),
      project: ctx.get("project"),
      sources: ctx.get("sources"),
      tasks: { spawnTask, python: VENV_PYTHON, onEnd: (fn) => ctx.listen(taskEvents, "end", fn) },
    });
  },
  routes: resourceRoutes,
  functions: RESOURCE_FUNCTIONS,
};
