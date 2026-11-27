/** HTTP của module ai (đường dẫn API giữ như cũ). Model dịch của Antigravity: đọc từ cache; POST làm mới (hỏi lại `agy models`). */
export default async function aiRoutes(app, ctx, ai) {
  app.get("/api/agy-models", async () => ai.models());
  app.post("/api/agy-models/refresh", async () => ai.models({ refresh: true }));
}
