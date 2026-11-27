/** Đọc/ghi dữ liệu của module project: data/projects/<id>.json + video nguồn gán dự án (bản lồng tiếng: qua module dub). */
import fs from "node:fs";
import path from "node:path";
import { STORY_PROJECTS_DIR } from "../../config.mjs";
import { readVideoProjects, unassignVideoProjects } from "../../lib/store.mjs";
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
  /** Sửa 1 dự án tại chỗ (fn(proj) đổi trực tiếp); false nếu không có dự án. */
  update(id, fn) {
    const file = projectFile(id);
    const proj = fs.existsSync(file) ? readJson(file, null) : null;
    if (!proj) return false;
    fn(proj);
    writeJson(file, proj);
    return true;
  },
  /** Sửa mọi dự án: fn(proj) trả true thì ghi lại file đó. */
  updateAll(fn) {
    if (!fs.existsSync(STORY_PROJECTS_DIR)) return;
    for (const f of fs.readdirSync(STORY_PROJECTS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(STORY_PROJECTS_DIR, f);
      const proj = readJson(file, null);
      if (proj && fn(proj)) writeJson(file, proj);
    }
  },
  /** Xóa file dự án; video nguồn của dự án thành "chưa gán dự án" (file media không bị xóa). */
  remove(id) {
    fs.rmSync(projectFile(id), { force: true });
    unassignVideoProjects(id);
  },
  /** Video nguồn (rel) -> project_id. */
  owners: readVideoProjects,
  sourceExists: (rel) => fs.existsSync(resolveDownload(rel)),
};
