/** Gộp video nguồn + bản lồng tiếng + job đang dở thành 1 dòng trên trang Video & Lồng tiếng. */
import { BiliVideo, Dubbed, Job, Source, fileUrl } from "@/lib/api";

export type WorkItem = Source & {
  title: string;
  /** Mã BV khi video không có tiêu đề gốc (hiện ở dòng phụ để còn phân biệt). */
  code: string;
  uploader: string;
  delogo: string;
  video_src: string;
  dub: Dubbed | null;
  job: Job | null;
  status: "new" | "partial" | "dubbed";
  /** Bản lồng tiếng của dự án mà video gốc đã bị xóa khỏi ổ: vẫn xem/tải được, không lồng tiếng lại được. */
  missing: boolean;
};

/** Tên hiển thị của 1 video theo tên file: tiêu đề Bilibili/YouTube nếu có, không thì tên file. Dùng chung cho danh sách và trang chỉnh. */
export function displayTitle(fileName: string, bili: BiliVideo[]): string {
  return bili.find((b) => b.local_file === fileName)?.title || fallbackTitle(fileName).title;
}

/** Tên file thô (vd "BV1wyxS62Etu_p1_sec_000000-000800_1-398.mp4") không phải tên đọc được:
 *  trả về tiêu đề thay thế + mã BV để đưa xuống dòng phụ. Tên file thường thì giữ nguyên (bỏ đuôi). */
export function fallbackTitle(fileName: string): { title: string; code: string } {
  const bv = fileName.match(/^(BV[0-9A-Za-z]{10})(?:_p(\d+))?/);
  if (bv) return { title: "Video không có tên gốc", code: bv[2] ? `${bv[1]} · phần ${bv[2]}` : bv[1] };
  return { title: fileName.replace(/\.(mp4|mkv|webm|mov)$/i, ""), code: "" };
}

/** Video của dự án đang mở + video chưa gán dự án nào (để người dùng chọn đưa vào dự án). */
export function buildWorkItems(sources: Source[], dubbed: Dubbed[], bili: BiliVideo[], pid: string): WorkItem[] {
  // Nhiều bản lồng tiếng cùng 1 video gốc: ưu tiên bản thuộc dự án đang mở (cùng hạng thì bản sau thắng, như trước).
  const dubByTitle = new Map<string, Dubbed>();
  for (const d of dubbed) {
    const cur = dubByTitle.get(d.title);
    if (!cur || d.project_id === pid || cur.project_id !== pid) dubByTitle.set(d.title, d);
  }
  const biliByFile = new Map(bili.map((b) => [b.local_file, b]));
  const items: WorkItem[] = sources
    .filter((s) => !s.project_id || s.project_id === pid)
    .map((s) => {
      const meta = biliByFile.get(s.name) || ({} as BiliVideo);
      const dub = dubByTitle.get(s.name) || null;
      const job = s.job && s.job.status !== "done" ? s.job : null;
      const fb = meta.title ? { title: meta.title, code: "" } : fallbackTitle(s.name);
      return {
        ...s,
        title: fb.title,
        code: fb.code,
        uploader: meta.uploader || "",
        delogo: meta.delogo || "none",
        video_src: fileUrl(s.rel_path),
        dub,
        job,
        // Đếm giống thẻ dự án (server/modules/project/service.mjs stats): có bản lồng tiếng thuộc dự án này là "đã lồng",
        // kể cả khi còn một lượt chạy lại đang dở; bản lồng tiếng chưa gán dự án thì không tính.
        status: dub && dub.project_id === pid ? "dubbed" : job ? "partial" : "new",
        missing: false,
      };
    });
  // Bản lồng tiếng thuộc dự án nhưng không còn video gốc nào trên ổ: thẻ dự án vẫn đếm nó là 1 video,
  // nên ở đây cũng hiện 1 dòng riêng để hai nơi khớp số và bản Việt không bị ẩn mất.
  const sourceNames = new Set(sources.map((s) => s.name));
  for (const d of dubbed) {
    if (d.project_id !== pid || sourceNames.has(d.title)) continue;
    const fb = fallbackTitle(d.title);
    items.push({
      source: "dubbed",
      rel_path: `downloads/dubbed/${d.mp4_file}`,
      name: d.title,
      size_mb: Number(d.size_mb || 0),
      mtime: d.updated_at ? Date.parse(d.updated_at) || 0 : 0,
      duration_sec: Number(d.duration_sec || 0),
      resolution: "",
      project_id: pid,
      job: null,
      title: fb.title,
      code: fb.code,
      uploader: "",
      delogo: "none",
      video_src: "",
      dub: d,
      status: "dubbed",
      missing: true,
    });
  }
  return items;
}
