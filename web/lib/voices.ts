/** Nhãn và danh sách giọng đọc cho ô chọn. */
import { Project, Voice, getBlob } from "./api";

export const GENDER_LABEL: Record<string, string> = { male: "nam", female: "nữ" };
export const DEFAULT_PREVIEW_TEXT = "Xin chào các bạn, hôm nay chúng ta cùng xem một tập phim mới nhé!";

export function voiceLabel(all: Voice[], id: string) {
  const v = all.find((x) => x.id === id);
  if (!v) return id; // giọng clone đã bị xóa: vẫn hiện mã để người dùng biết
  if (v.kind === "clone") return `${v.name} — giọng clone${v.gender ? `, ${GENDER_LABEL[v.gender]}` : ""}`;
  return `VieNeu · ${v.name} — ${GENDER_LABEL[v.gender]}, ${v.desc}`;
}

/** [[mã, nhãn]] cho ô chọn giọng: cả thư viện (dùng chung mọi dự án); giọng dự án từng chọn đứng đầu để giữ
 *  giọng mặc định cũ. `keep` (giọng đang dùng) luôn có mặt để không bị đổi ngầm. */
export function voiceOptions(all: Voice[], proj: Project | null | undefined, keep = ""): [string, string][] {
  return [...new Set([...(proj?.voice ? [proj.voice] : []), ...(proj?.voices || []), ...all.map((v) => v.id), ...(keep ? [keep] : [])])].map((id) => [
    id,
    voiceLabel(all, id),
  ]);
}

let player: HTMLAudioElement | null = null;

/** Phát 1 đường dẫn âm thanh (lần đầu máy phải đọc thử 10–20 giây). Ném lỗi có thông báo tiếng Việt. */
export async function playVoiceUrl(url: string) {
  const blob = await getBlob(url);
  player?.pause();
  if (player) URL.revokeObjectURL(player.src);
  player = new Audio(URL.createObjectURL(blob));
  await player.play();
}
