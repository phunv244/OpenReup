/**
 * Module ai: model dịch của Antigravity (`agy models`, cache data/agy_models.json).
 * Service cho module khác (ctx.get("ai")): models({refresh}), validModel(id).
 * Hàm /api/functions: refresh_ai_models (functions.mjs). list_options (module resources) đọc /api/agy-models qua HTTP;
 * resources khai deps "ai" nên thiếu module này thì server lỗi ngay lúc khởi động.
 * Việc dịch/nhận diện thật chạy trong dub_video.py (module dub); mô hình nhận diện (ASR) là tài nguyên tải về, thuộc module resources.
 */
import { AI_FUNCTIONS } from "./functions.mjs";
import { aiRepo } from "./repo.mjs";
import aiRoutes from "./routes.mjs";
import { createAiService } from "./service.mjs";

export default {
  name: "ai",
  init: () => createAiService(aiRepo),
  routes: aiRoutes,
  functions: AI_FUNCTIONS,
};
