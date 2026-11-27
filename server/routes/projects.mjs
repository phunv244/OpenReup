/** Dự án truyện / phim (data/projects/<id>.json). */
import fs from "node:fs";
import path from "node:path";
import { STORY_PROJECTS_DIR } from "../config.mjs";
import { readDubSources, readDubbed, readVideoProjects, unassignProject } from "../lib/store.mjs";
import { fail, nowIso, projectFile, readJson, resolveDownload, validVoice, writeJson } from "../lib/util.mjs";

export default async function projectRoutes(app) {
  app.get("/api/projects", async () => {
    fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
    const dubbed = readDubbed();
    const dubSources = readDubSources();
    const owners = readVideoProjects();
    const projects = [];
    for (const f of fs.readdirSync(STORY_PROJECTS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = readJson(path.join(STORY_PROJECTS_DIR, f), null);
      if (!p) continue;
      const vids = dubbed.filter((v) => v.project_id === p.id);
      // 1 video = 1 video nguồn, dù lồng tiếng bao nhiêu lần. Bản lồng tiếng mất meta thì tự nó là 1 video.
      const dubbedKeys = new Set(vids.map((v) => dubSources.get(v.job_id) || `job:${v.job_id}`));
      const all = new Set(dubbedKeys);
      for (const [rel, pid] of Object.entries(owners)) if (pid === p.id && fs.existsSync(resolveDownload(rel))) all.add(rel);
      projects.push({
        ...p,
        video_count: all.size,
        dubbed_count: dubbedKeys.size,
        pending_count: all.size - dubbedKeys.size,
        videos: vids,
      });
    }
    projects.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return { total: projects.length, projects };
  });

  app.post("/api/projects", async (req, reply) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return fail(reply, 400, "Vui lòng nhập tên dự án.");
    fs.mkdirSync(STORY_PROJECTS_DIR, { recursive: true });
    const slugBase =
      name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || `du-an-${Date.now()}`;
    let id = slugBase;
    for (let n = 2; fs.existsSync(projectFile(id)); n++) id = `${slugBase}-${n}`;
    const now = nowIso();
    const proj = {
      id,
      name,
      type: String(body.type || "Truyện / Hoạt hình"),
      style: String(body.style || "Tự nhiên, dễ nghe, đúng mạch truyện"),
      synopsis: String(body.synopsis || ""),
      characters: Array.isArray(body.characters) ? body.characters : [],
      glossary: Array.isArray(body.glossary) ? body.glossary : [],
      episode_notes: {},
      voice: body.voice && validVoice(body.voice) ? String(body.voice) : "",
      voices: [],
      created_at: now,
      updated_at: now,
    };
    writeJson(projectFile(id), proj);
    return { ok: true, project: proj };
  });

  app.post("/api/projects/save", async (req, reply) => {
    const body = req.body || {};
    const id = path.basename(String(body.id || ""));
    const filePath = projectFile(id);
    if (!id || !fs.existsSync(filePath)) return fail(reply, 404, "Không tìm thấy dự án.");
    const old = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const updated = {
      ...old,
      name: body.name !== undefined ? String(body.name).trim() || old.name : old.name,
      type: body.type !== undefined ? String(body.type) : old.type,
      style: body.style !== undefined ? String(body.style) : old.style,
      synopsis: body.synopsis !== undefined ? String(body.synopsis) : old.synopsis,
      // Nhân vật không còn giọng riêng: cả dự án dùng chung 1 giọng (field `voice` dưới đây).
      characters: Array.isArray(body.characters)
        ? body.characters.map(({ zh, vi, pronouns, role, personality }) => ({ zh, vi, pronouns, role, personality }))
        : old.characters || [],
      glossary: Array.isArray(body.glossary) ? body.glossary : old.glossary || [],
      episode_notes: body.episode_notes && typeof body.episode_notes === "object" ? body.episode_notes : old.episode_notes || {},
      // Giọng đọc dùng chung cho mọi nhân vật trong dự án, chọn ở Tài nguyên → Giọng đọc.
      voice: body.voice !== undefined ? (validVoice(body.voice) ? String(body.voice) : "") : old.voice || "",
      voices: Array.isArray(body.voices) ? [...new Set(body.voices.map(String).filter(validVoice))].slice(0, 30) : old.voices || [],
      updated_at: nowIso(),
    };
    writeJson(filePath, updated);
    return { ok: true, project: updated };
  });

  app.post("/api/projects/delete", async (req) => {
    const id = path.basename(String(req.body?.id || ""));
    if (id) {
      fs.rmSync(projectFile(id), { force: true });
      unassignProject(id); // video của dự án bị xóa thành "chưa gán dự án" (file không bị xóa)
    }
    return { ok: true };
  });
}
