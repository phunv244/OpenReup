/**
 * Module project: dự án truyện / phim (nhân vật, thuật ngữ, giọng dùng chung) + đếm video theo dự án.
 * Service cho module khác (ctx.get("project")): list(), stats(projectId), exists(id), create(body), save(id, body), remove(id).
 */
import { PROJECT_FUNCTIONS } from "./functions.mjs";
import { projectRepo } from "./repo.mjs";
import projectRoutes from "./routes.mjs";
import { createProjectService } from "./service.mjs";

export default {
  name: "project",
  init: () => createProjectService(projectRepo),
  routes: projectRoutes,
  functions: PROJECT_FUNCTIONS,
};
