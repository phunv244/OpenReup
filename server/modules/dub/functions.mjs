/** Hàm /api/functions của module dub (MausBot gọi qua đây; định dạng như server/routes/functions.mjs). */
import fs from "node:fs";
import path from "node:path";
import { DUB_PROJECTS_DIR } from "../../config.mjs";
import { P_DELOGO, P_PROJECT, P_SUBCOVER, P_SUB_STYLE, P_VOICE, bool, num, str } from "../../core/schema.mjs";
import { fileInfo, relOf, resolveDownload } from "../../lib/util.mjs";
import { jobPaths, lookupDownload } from "../../lib/videos.mjs";
import { dubRepo } from "./repo.mjs";

const { readDubJobs, readDubbed } = dubRepo;

/** Kết quả trả model khi 1 lần lồng tiếng / xuất lại xong: file video + phụ đề + thông tin bản lồng tiếng. */
function dubResult(job) {
  if (!job) return {};
  const done = readDubbed().find((v) => v.job_id === job.job_id) || {};
  const out = { job_id: job.job_id, project_file: jobPaths(job.job_id)?.project || path.join(DUB_PROJECTS_DIR, `${job.job_id}.json`) };
  for (const [k, f] of [["video", done.mp4_file || `${job.job_id}.mp4`], ["subtitle", done.srt_file || `${job.job_id}.srt`]]) {
    const abs = lookupDownload(`downloads/dubbed/${f}`)?.abs;
    if (abs && fs.existsSync(abs)) out[k] = fileInfo(abs);
  }
  for (const k of ["title", "duration_sec", "segment_count", "untranslated", "size_mb"]) if (done[k] !== undefined) out[k] = done[k];
  return out;
}
/** Job lồng tiếng của 1 video nguồn, so theo rel_path logic (đã chuẩn hóa), không theo đường dẫn tuyệt đối. */
const dubJobOf = (relPath) => {
  const abs = resolveDownload(relPath);
  return (abs && readDubJobs().get(relOf(abs))) || null;
};

export const DUB_FUNCTIONS = [
  {
    name: "dub_video",
    description:
      "Reup 1 video: nhận diện lời thoại tiếng Trung, dịch, lồng tiếng Việt, in phụ đề, xóa logo. Chạy nền (vài phút tới vài giờ): " +
      "trả call_id ngay, dùng get_call để lấy video + phụ đề khi xong. Chạy lại cùng video sẽ nối tiếp từ chỗ dở.",
    route: ["POST", "/api/dub/start"],
    task: true,
    result: (a) => dubResult(dubJobOf(a.rel_path)),
    fail: (a) => dubJobOf(a.rel_path)?.error || "",
    parameters: {
      rel_path: str('Video nguồn, ví dụ "downloads/bilibili/abc.mp4" (lấy từ list_sources hoặc kết quả download_video).'),
      voice: P_VOICE,
      model: str("Mô hình nhận diện giọng nói (id trong list_options.asr_models).", { default: "sensevoice-small" }),
      speed: num("Tốc độ phát khi nhận diện (làm chậm để nghe rõ hơn).", { default: 0.5, minimum: 0.25, maximum: 1 }),
      bg_volume: num("Âm lượng tiếng gốc giữ lại làm nền, 0 = tắt hẳn.", { default: 0.05, minimum: 0, maximum: 1 }),
      delogo: P_DELOGO,
      subcover: P_SUBCOVER,
      burn_sub: bool("In cứng phụ đề Việt lên hình (mặc định true)."),
      agy_model: str("Model dịch của Antigravity (id trong list_options.agy_models). Bỏ trống = mặc định."),
      sub_style: P_SUB_STYLE,
      project_id: P_PROJECT,
      fresh: bool("Bỏ toàn bộ tiến độ / cache cũ của video này và làm lại từ đầu."),
    },
    required: ["rel_path"],
  },
  {
    name: "rerender_video",
    description:
      "Xuất lại 1 bản lồng tiếng đã có sau khi đổi cấu hình hoặc sửa lời thoại. Chỉ làm lại phần bị ảnh hưởng (hình hoặc tiếng). Chạy nền.",
    route: ["POST", "/api/dub/rerender"],
    task: true,
    result: (a) => dubResult({ job_id: a.job_id }),
    parameters: {
      job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed)."),
      voice: P_VOICE,
      bg_volume: num("Âm lượng tiếng gốc làm nền.", { minimum: 0, maximum: 1 }),
      burn_sub: bool("In cứng phụ đề Việt."),
      delogo: P_DELOGO,
      subcover: P_SUBCOVER,
      sub_style: P_SUB_STYLE,
      edits: { type: "object", description: 'Sửa lời Việt theo mã câu: {"12": "lời mới"}.', additionalProperties: { type: "string" } },
      speaker_voices: { type: "object", description: 'Đổi giọng của nhân vật: {"NV1": "vieneu:Hải Đăng"}.', additionalProperties: { type: "string" } },
      speaker_edits: { type: "object", description: 'Đổi người nói của câu: {"12": "NV2"}.', additionalProperties: { type: "string" } },
    },
    required: ["job_id"],
  },
  {
    name: "list_segments_outline",
    nolog: true,
    description: "Lấy mốc giờ + người nói của mọi câu trong 1 bản lồng tiếng (không kèm lời) — dùng để vẽ/duyệt timeline. Tối đa 4000 câu đầu.",
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed).") },
    required: ["job_id"],
    run: async (a, get) => get(`/api/dub/outline?id=${encodeURIComponent(a.job_id)}`),
  },
  {
    name: "edit_segment",
    description: "Sửa mốc giờ (kéo đầu/cuối) hoặc người nói của 1 câu trong bản lồng tiếng. Ghi ngay; cần rerender_video để thấy trên video đã xuất.",
    route: ["POST", "/api/dub/segment/update"],
    parameters: {
      job_id: str("Mã bản lồng tiếng."),
      id: num("Mã câu (id trong list_segments_outline / get_call của dub_video)."),
      start: num("Mốc giờ bắt đầu mới, giây."),
      end: num("Mốc giờ kết thúc mới, giây."),
      speaker: str("Người nói mới (mã nhân vật, ví dụ \"NV2\")."),
    },
    required: ["job_id", "id"],
  },
  {
    name: "split_segment",
    description: "Cắt 1 câu làm 2 tại 1 mốc giờ. Câu đầu giữ lời cũ, câu sau để trống để gõ lại lời mới.",
    route: ["POST", "/api/dub/segment/split"],
    parameters: {
      job_id: str("Mã bản lồng tiếng."),
      id: num("Mã câu cần cắt."),
      at: num("Mốc giờ cắt, giây (phải nằm giữa câu)."),
    },
    required: ["job_id", "id", "at"],
  },
  {
    name: "merge_segments",
    description: "Ghép 2 câu liền kề làm 1 (nối lời Trung + Việt, giữ người nói của câu trước).",
    route: ["POST", "/api/dub/segment/merge"],
    parameters: {
      job_id: str("Mã bản lồng tiếng."),
      id: num("Mã câu thứ nhất."),
      with_id: num("Mã câu thứ hai (cần liền kề câu thứ nhất)."),
    },
    required: ["job_id", "id", "with_id"],
  },
  {
    name: "delete_segment",
    description: "Xóa 1 câu khỏi bản lồng tiếng (chỉ xóa dòng lời, cần rerender_video để video khớp lại).",
    route: ["POST", "/api/dub/segment/delete"],
    parameters: { job_id: str("Mã bản lồng tiếng."), id: num("Mã câu cần xóa.") },
    required: ["job_id", "id"],
  },
  { name: "list_dubbed", description: "Liệt kê các bản lồng tiếng đã xuất (job_id, file mp4 / srt, cấu hình đã dùng).", route: ["GET", "/api/dubbed"], parameters: {} },
  {
    name: "assign_video_project",
    description: "Gán 1 bản lồng tiếng (job_id) vào 1 dự án Reup, để dùng chung nhân vật / thuật ngữ / mạch truyện.",
    route: ["POST", "/api/dub/assign"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed)."), project_id: str("Mã dự án (id trong list_options.projects). Bỏ trống = gỡ khỏi dự án.") },
    required: ["job_id"],
  },
  {
    name: "clean_dub_cache",
    description: "Xóa cache tạm (âm thanh giọng đã tổng hợp + hình đã mã hóa) của 1 bản lồng tiếng để lấy lại ổ cứng. Bản lồng tiếng cuối cùng vẫn được giữ.",
    route: ["POST", "/api/dub/clean"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed).") },
    required: ["job_id"],
  },
  {
    name: "delete_dub_job",
    description: "Xóa hẳn 1 bản lồng tiếng (file video/phụ đề xuất ra + toàn bộ dữ liệu câu thoại). Không thể hoàn tác.",
    route: ["POST", "/api/dub/delete"],
    parameters: { job_id: str("Mã bản lồng tiếng (job_id trong list_dubbed).") },
    required: ["job_id"],
  },
];
