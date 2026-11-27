/**
 * Đọc/ghi dữ liệu của module project: data/projects/<id>.json và data/video_projects.json (video nguồn → dự án).
 * Module này là chủ duy nhất của video_projects.json; module khác đọc/ghi qua service (videoOwners, assignVideo, unassignVideo).
 * Bản lồng tiếng gán dự án: module dub.
 */
import fs from "node:fs";
import path from "node:path";
import { STORY_PROJECTS_DIR, VIDEO_PROJECTS_JSON } from "../../config.mjs";
import { projectFile, readJson, resolveDownload, writeJson } from "../../lib/util.mjs";

const readOwners = () => readJson(VIDEO_PROJECTS_JSON, {});

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
    const map = readOwners();
    for (const rel of Object.keys(map)) if (map[rel] === id) delete map[rel];
    writeJson(VIDEO_PROJECTS_JSON, map);
  },
  /** Video nguồn (rel) -> project_id. */
  owners: readOwners,
  /** Gán / bỏ gán ("") 1 video nguồn. */
  setOwner(rel, projectId) {
    const map = readOwners();
    if (projectId) map[rel] = projectId;
    else delete map[rel];
    writeJson(VIDEO_PROJECTS_JSON, map);
  },
  sourceExists: (rel) => fs.existsSync(resolveDownload(rel)),
};
