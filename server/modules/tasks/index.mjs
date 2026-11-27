/**
 * Module tasks: tiến trình nền (lib/tasks.mjs: 1 tác vụ chạy + hàng đợi), thông tin máy, và nhật ký các lần gọi hàm (lib/function-calls.mjs).
 * Không có service riêng: module khác chạy tác vụ nền qua lib/tasks.mjs (spawnTask) dùng chung.
 */
import { TASK_FUNCTIONS } from "./functions.mjs";
import taskRoutes from "./routes.mjs";

export default {
  name: "tasks",
  routes: taskRoutes,
  functions: TASK_FUNCTIONS,
};
