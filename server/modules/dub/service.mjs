/** Nghiệp vụ lồng tiếng dùng chung cho module khác: danh sách bản lồng tiếng, nguồn, dự án đang bận, tham số đường dẫn cho dub_video.py. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DUBBED_DIR, DUBBED_JSON, DUB_PROJECTS_DIR, DUB_WORK_DIR, ROOT, STORY_PROJECTS_DIR } from "../../config.mjs";

/** str(float) của Python cho tốc độ (1 -> "1.0", 0.65 -> "0.65"). */
const pyFloat = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Path.stem của Python 3.13: "foo." và ".foo" giữ nguyên, khác path.parse().name của Node. */
const pyStem = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
};

/**
 * job_id mà dub_video.py tạo cho 1 video nguồn (giữ khớp với nhánh --input trong dub_video.py).
 * Python gọi Path(input).resolve(): file nguồn là symlink thì lấy tên file đích.
 */
export function jobIdFor(inputAbs, speed) {
  const name = path.basename(fs.existsSync(inputAbs) ? fs.realpathSync(inputAbs) : inputAbs);
  const stem = pyStem(name);
  let s = stem.replace(/[^0-9a-zA-Z_-]+/g, "_").slice(0, 32).replace(/^_+|_+$/g, "") || "video";
  if (s !== stem) s += "_" + crypto.createHash("sha1").update(name, "utf8").digest("hex").slice(0, 6);
  return `dub_${s}_${pyFloat(Math.max(0.25, Math.min(1.5, speed))).replace(".", "p")}x`;
}

/** Mã dự án của 1 tác vụ lồng tiếng: dub_video lấy --story-project, dub_rerender lấy project_id trong file project của job. */
function taskProject(t, loadDubProject) {
  if (t.type === "dub_video") {
    const i = t.args.indexOf("--story-project");
    return i >= 0 ? String(t.args[i + 1]) : "";
  }
  return loadDubProject(t.target)?.project_id || "";
}

/** repo: dubRepo (repo.mjs) hoặc bản giả trong test. */
export function createDubService(repo) {
  return {
    jobIdFor,
    /** Bản lồng tiếng trong data/dubbed.json (có project_id). */
    list: () => repo.readDubbed(),
    /** job_id → video nguồn (rel). */
    sources: () => repo.readDubSources(),
    /** Dự án bị xóa: bản lồng tiếng của nó về "chưa gán dự án". */
    unassignProject: (projectId) => repo.updateDubbed((vids) => vids.forEach((v) => v.project_id === projectId && (v.project_id = ""))),
    /** Dự án đang có video lồng tiếng / xuất lại chạy hoặc chờ trong hàng đợi. */
    isProjectBusy: (projectId) => Boolean(projectId) && repo.dubTasks().some((t) => taskProject(t, repo.loadDubProject) === projectId),

    /**
     * Tham số đường dẫn luôn truyền cho dub_video.py (kể cả khi chạy tiếp job dở): thư mục làm việc / xuất đã lưu
     * trong file project của job (Python ghi tương đối với ROOT), không có thì mặc định theo DATA_DIR của server.
     */
    pathArgs(jobId) {
      const proj = repo.loadDubProject(jobId) || {};
      const at = (saved, dflt) => (saved ? path.resolve(ROOT, String(saved)) : dflt);
      return [
        "--work-dir", at(proj.work_dir, path.join(DUB_WORK_DIR, jobId)),
        "--out-dir", at(proj.out_dir, DUBBED_DIR),
        "--project-file", path.join(DUB_PROJECTS_DIR, `${jobId}.json`),
        "--index-file", DUBBED_JSON,
        "--story-dir", STORY_PROJECTS_DIR,
      ];
    },
  };
}
