import path from "node:path";
/** Đọc/ghi dữ liệu lồng tiếng: data/dubbed.json, data/dub_projects/<job>.json, thư mục làm việc <work_dir>/meta.json. */
import { dubWorkDirs, removeDubWorkDir, loadDubProject, readDubJobs, readDubbed, removeDubJob, saveDubProject, updateDubbed } from "../../lib/store.mjs";
import { queue, task } from "../../lib/tasks.mjs";
import { readJson, relOf } from "../../lib/util.mjs";

export const dubRepo = {
  readDubbed,
  updateDubbed,
  loadDubProject,
  saveDubProject,
  removeDubJob,
  readDubJobs,
  removeDubWorkDir,

  /** job_id → video nguồn (rel) của bản lồng tiếng, đọc meta.json theo work_dir (dubbed.json) hoặc data/dub_work/<job>. */
  readDubSources() {
    const out = new Map();
    for (const [jobId, dir] of dubWorkDirs()) {
      const meta = readJson(path.join(dir, "meta.json"), null);
      if (meta?.input_path) out.set(meta.job_id || jobId, relOf(meta.input_path));
    }
    return out;
  },

  /** Tác vụ lồng tiếng đang chạy + đang chờ: [{ type, target, args }]. */
  dubTasks: () => [...(task.proc ? [task] : []), ...queue].filter((t) => t.type.startsWith("dub_")),
};
