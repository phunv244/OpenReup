/** Gộp video nguồn + bản lồng tiếng + job đang dở thành 1 dòng trên trang Video & Lồng tiếng. */
import { BiliVideo, Dubbed, Job, Source, fileUrl } from "@/lib/api";

export type WorkItem = Source & {
  title: string;
  uploader: string;
  delogo: string;
  video_src: string;
  dub: Dubbed | null;
  job: Job | null;
  status: "new" | "partial" | "dubbed";
};

/** Video của dự án đang mở + video chưa gán dự án nào (để người dùng chọn đưa vào dự án). */
export function buildWorkItems(sources: Source[], dubbed: Dubbed[], bili: BiliVideo[], pid: string): WorkItem[] {
  const dubByTitle = new Map(dubbed.map((d) => [d.title, d]));
  const biliByFile = new Map(bili.map((b) => [b.local_file, b]));
  return sources
    .filter((s) => !s.project_id || s.project_id === pid)
    .map((s) => {
      const meta = biliByFile.get(s.name) || ({} as BiliVideo);
      const dub = dubByTitle.get(s.name) || null;
      const job = s.job && s.job.status !== "done" ? s.job : null;
      return {
        ...s,
        title: meta.title || s.name,
        uploader: meta.uploader || "",
        delogo: meta.delogo || "none",
        video_src: fileUrl(s.rel_path),
        dub,
        job,
        status: job ? "partial" : dub ? "dubbed" : "new",
      };
    });
}
