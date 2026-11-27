/** Nghiệp vụ dự án truyện / phim. Lỗi do input: ném Error có statusCode (error handler trả {ok:false, error}). */
import { nowIso, validVoice } from "../../lib/util.mjs";

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const slugOf = (name) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || `du-an-${Date.now()}`;

/** repo: projectRepo (repo.mjs), dub: service của module dub (ctx.get("dub")) — hoặc bản giả trong test. */
export function createProjectService(repo, dub) {
  /** Ảnh chụp dữ liệu video dùng để đếm: đọc 1 lần cho cả danh sách dự án. */
  const videoSnapshot = () => ({
    dubbed: dub.list(), // bản lồng tiếng (có project_id)
    dubSources: dub.sources(), // job_id -> video nguồn (rel)
    owners: repo.owners(), // video nguồn (rel) -> project_id
    sourceExists: repo.sourceExists,
  });

  /**
   * Đếm video của 1 dự án. 1 video = 1 video nguồn, dù lồng tiếng bao nhiêu lần; bản lồng tiếng mất meta thì tự nó là 1 video.
   * Video nguồn gán dự án nhưng file đã mất thì không đếm. snap: truyền vào khi đếm nhiều dự án để chỉ đọc dữ liệu 1 lần.
   */
  function stats(projectId, snap = videoSnapshot()) {
    const videos = snap.dubbed.filter((v) => v.project_id === projectId);
    const dubbedKeys = new Set(videos.map((v) => snap.dubSources.get(v.job_id) || `job:${v.job_id}`));
    const all = new Set(dubbedKeys);
    for (const [rel, pid] of Object.entries(snap.owners)) if (pid === projectId && snap.sourceExists(rel)) all.add(rel);
    return { video_count: all.size, dubbed_count: dubbedKeys.size, pending_count: all.size - dubbedKeys.size, videos };
  }

  return {
    stats,

    list() {
      const snap = videoSnapshot();
      const projects = repo.list().map((p) => ({ ...p, ...stats(p.id, snap) }));
      projects.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
      return projects;
    },

    exists: (id) => Boolean(id) && repo.exists(id),

    create(body) {
      const name = String(body.name || "").trim();
      if (!name) throw httpError(400, "Vui lòng nhập tên dự án.");
      const base = slugOf(name);
      let id = base;
      for (let n = 2; repo.exists(id); n++) id = `${base}-${n}`;
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
      repo.write(proj);
      return proj;
    },

    save(id, body) {
      const old = id ? repo.get(id) : null;
      if (!old) throw httpError(404, "Không tìm thấy dự án.");
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
      repo.write(updated);
      return updated;
    },

    /** Thêm 1 giọng vào danh sách giọng của dự án (dự án không có thì bỏ qua). */
    addVoice(id, voiceId) {
      repo.update(id, (proj) => (proj.voices = [...new Set([...(proj.voices || []), voiceId])]));
    },
    /** Gỡ 1 giọng khỏi mọi dự án đang chọn nó (giọng bị xóa khỏi Tài nguyên). */
    dropVoice(voiceId) {
      repo.updateAll((proj) => {
        if (!proj.voices?.includes(voiceId)) return false;
        proj.voices = proj.voices.filter((x) => x !== voiceId);
        return true;
      });
    },

    /** Xóa dự án; bản lồng tiếng của nó về "chưa gán". Đang lồng tiếng video của dự án thì từ chối (Python sẽ ghi lại project_id cũ). */
    remove(id) {
      if (!id) return;
      if (dub.isProjectBusy(id)) throw httpError(409, "Dự án đang có video lồng tiếng chạy hoặc chờ trong hàng đợi. Hãy chờ xong hoặc dừng tác vụ trước khi xóa dự án.");
      repo.remove(id);
      dub.unassignProject(id);
    },
  };
}
