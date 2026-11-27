/**
 * Module ai: model dịch của Antigravity (`agy models`, cache data/agy_models.json).
 * Service cho module khác (ctx.get("ai")): models({refresh}), validModel(id).
 * Không có hàm /api/functions riêng: list_options (server/routes/functions.mjs) đọc /api/agy-models qua HTTP như mọi nguồn khác;
 * module "functions" (server/app.mjs) khai deps "ai" nên thiếu module này thì server lỗi ngay lúc khởi động.
 * Việc dịch/nhận diện thật chạy trong dub_video.py (module dub); mô hình nhận diện (ASR) là tài nguyên tải về, thuộc module resources.
 */
import { aiRepo } from "./repo.mjs";
import aiRoutes from "./routes.mjs";
import { createAiService } from "./service.mjs";

export default {
  name: "ai",
  init: () => createAiService(aiRepo),
  routes: aiRoutes,
};
