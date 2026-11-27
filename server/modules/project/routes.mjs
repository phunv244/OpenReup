/** HTTP của module project: chỉ đọc request, gọi service, trả JSON (đường dẫn API giữ như cũ). */
import path from "node:path";

const idOf = (v) => path.basename(String(v || ""));

export default async function projectRoutes(app, ctx, project) {
  app.get("/api/projects", async () => {
    const projects = project.list();
    return { total: projects.length, projects };
  });
  app.post("/api/projects", async (req) => ({ ok: true, project: project.create(req.body || {}) }));
  app.post("/api/projects/save", async (req) => ({ ok: true, project: project.save(idOf(req.body?.id), req.body || {}) }));
  app.post("/api/projects/delete", async (req) => {
    project.remove(idOf(req.body?.id));
    return { ok: true };
  });
}
