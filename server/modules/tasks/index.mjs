/**
 * Module tasks: tiến trình nền (lib/tasks.mjs: 1 tác vụ chạy + hàng đợi), thông tin máy, và nhật ký các lần gọi hàm (lib/function-calls.mjs).
 * Service (chỉ route của chính module dùng): disk(). Module khác chạy tác vụ nền qua lib/tasks.mjs (spawnTask) dùng chung.
 */
import { ROOT } from "../../config.mjs";
import { TASK_FUNCTIONS } from "./functions.mjs";
import taskRoutes from "./routes.mjs";
import { createTaskService } from "./service.mjs";

export default {
  name: "tasks",
  init: () => createTaskService(ROOT),
  routes: taskRoutes,
  functions: TASK_FUNCTIONS,
};
