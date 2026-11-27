/**
 * Module project: dự án truyện / phim (nhân vật, thuật ngữ, giọng dùng chung) + đếm video theo dự án.
 * Phụ thuộc: dub (bản lồng tiếng để đếm, gỡ khi xóa dự án, chặn xóa khi đang lồng tiếng).
 * Service cho module khác (ctx.get("project")): list(), stats(projectId), exists(id), create(body), save(id, body), remove(id), addVoice(id, voiceId), dropVoice(voiceId),
 *   videoOwners(), setVideoOwner(rel, projectId) — chủ duy nhất của data/video_projects.json.
 */
import { PROJECT_FUNCTIONS } from "./functions.mjs";
import { projectRepo } from "./repo.mjs";
import projectRoutes from "./routes.mjs";
import { createProjectService } from "./service.mjs";

export default {
  name: "project",
  deps: ["dub"],
  init: (ctx) => createProjectService(projectRepo, ctx.get("dub")),
  routes: projectRoutes,
  functions: PROJECT_FUNCTIONS,
};
