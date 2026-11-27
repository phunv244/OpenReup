/** Hàm /api/functions của module ai (schema đã được Techlead duyệt). */
export const AI_FUNCTIONS = [
  {
    name: "refresh_ai_models",
    description:
      "Hỏi lại Antigravity (`agy models`, mất vài giây) để cập nhật danh sách model dịch. Trả { models: [{id, name}] }. " +
      "Sau khi làm mới, list_options.agy_models đọc lại đúng danh sách này (id dùng cho tham số agy_model của dub_video).",
    parameters: {},
    run: async (a, get, post) => {
      const r = await post("/api/agy-models/refresh");
      return { models: r.models.map((m) => ({ id: m.id, name: m.name })) };
    },
  },
];
