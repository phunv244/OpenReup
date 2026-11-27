/** Đọc/ghi dữ liệu của module project: data/projects/<id>.json + dữ liệu video/bản lồng tiếng để đếm. */
import fs from "node:fs";
import path from "node:path";
import { STORY_PROJECTS_DIR } from "../../config.mjs";
import { readDubSources, readDubbed, readVideoProjects, unassignProject } from "../../lib/store.mjs";
import { projectFile, readJson, resolveDownload, writeJson } from "../../lib/util.mjs";

export const projectRepo = {
  /** Mọi dự án (file hỏng bị bỏ qua). */
  list() {
    fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
    return fs.readdirSync(STORY_PROJECTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(STORY_PROJECTS_DIR, f), null))
      .filter(Boolean);
  },
  get: (id) => readJson(projectFile(id), null),
  exists: (id) => fs.existsSync(projectFile(id)),
  write(proj) {
    fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
    writeJson(projectFile(proj.id), proj);
  },
  /** Xóa file dự án; video của dự án thành "chưa gán dự án" (file media không bị xóa). */
  remove(id) {
    fs.rmSync(projectFile(id), { force: true });
    unassignProject(id);
  },
  /** Ảnh chụp dữ liệu video dùng để đếm: đọc 1 lần cho cả danh sách dự án. */
  videoSnapshot: () => ({
    dubbed: readDubbed(), // bản lồng tiếng (có project_id)
    dubSources: readDubSources(), // job_id -> video nguồn (rel)
    owners: readVideoProjects(), // video nguồn (rel) -> project_id
    sourceExists: (rel) => fs.existsSync(resolveDownload(rel)),
  }),
};
