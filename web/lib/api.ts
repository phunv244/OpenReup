/** Gọi API của server Fastify (cùng origin; lúc dev được chuyển tiếp qua rewrites). */

export type ApiResult = { ok?: boolean; error?: string; [k: string]: unknown };

const AUTH_ERROR = "Máy chủ đang bật token (REUP_API_TOKEN) — giao diện chưa được cấp quyền ghi. Chạy server ở localhost hoặc mở qua đường có token.";

/** Đọc JSON trả về, gắn thông báo lỗi tiếng Việt khi server không tự ghi `error`. */
async function readResult<T>(res: Response): Promise<T & ApiResult> {
  let data = {} as T & ApiResult;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) data.error = AUTH_ERROR;
  else if (!res.ok && !data.error) data.error = `Lỗi máy chủ (HTTP ${res.status})`;
  return data;
}

/** GET JSON. Lỗi HTTP/401 không ném mà trả object có `error` (như postJSON), để thân lỗi không bị đọc nhầm thành dữ liệu. */
export async function getJSON<T = unknown>(url: string): Promise<T & ApiResult> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.ok) return res.json();
  return readResult<T>(res);
}

export async function postJSON<T = ApiResult>(url: string, body: unknown = {}): Promise<T & ApiResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResult<T>(res);
}

/** Tải 1 file lên (thân request là nội dung file thô, tên/đuôi nằm trong query của `url`). */
export async function uploadFile<T = ApiResult>(url: string, file: Blob): Promise<T & ApiResult> {
  const res = await fetch(url, { method: "POST", body: file });
  return readResult<T>(res);
}

/** Lấy dữ liệu nhị phân (ảnh khung hình, âm thanh). Có `body` thì gửi POST JSON. Lỗi thì ném Error có thông báo của server;
 *  hủy bằng `signal` thì ném AbortError như fetch. */
export async function getBlob(url: string, opts: { body?: unknown; signal?: AbortSignal; fallbackError?: string } = {}): Promise<Blob> {
  const res = await fetch(
    url,
    opts.body === undefined
      ? { signal: opts.signal }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body), signal: opts.signal }
  );
  if (!res.ok) {
    const d = await readResult(res);
    throw new Error(res.status === 401 ? AUTH_ERROR : d.error && !/^Lỗi máy chủ/.test(d.error) ? d.error : opts.fallbackError || d.error);
  }
  return res.blob();
}

/** "downloads/bilibili/a b.mp4" -> "/downloads/bilibili/a%20b.mp4" */
export const fileUrl = (rel: string) => "/" + rel.split("/").map(encodeURIComponent).join("/");
export const dubFileUrl = (file: string) => fileUrl(`downloads/dubbed/${file}`);
export const douyinFileUrl = (file: string) => fileUrl(`downloads/${file}`);

/* ---------- Kiểu dữ liệu server trả về ---------- */
export type Progress = { pct: number; label: string; eta: number | null; stage: number };
export type QueueItem = { id: number; type: string; target: string; added_at: number };
export type HistoryItem = { type: string; target: string; started_at: number; ended_at: number; exit_code: number | null };
export type TaskState = {
  running: boolean;
  task_type: string;
  last_type: string;
  target: string;
  progress: Progress;
  started_at: number;
  ended_at: number;
  exit_code: number | null;
  logs: string[];
  queue: QueueItem[];
  history: HistoryItem[];
};

/** personality: tính cách (AI tự ghi từ lời thoại, sửa được). Giọng đọc dùng chung cho mọi nhân vật, xem Project.voice. */
export type Character = { zh: string; vi: string; pronouns?: string; role?: string; personality?: string };
/** Nhóm giọng trong 1 video: name/zh = nhân vật trong truyện mà bước phân vai đoán ra; is_new = chưa có trong ngữ cảnh trước video này. */
export type Speaker = { voice: string; lines?: number; f0?: number; name?: string; zh?: string; is_new?: boolean };
export type GlossItem = { zh: string; vi: string };

export type Project = {
  id: string;
  name: string;
  type?: string;
  style?: string;
  synopsis?: string;
  characters?: Character[];
  glossary?: GlossItem[];
  episode_notes?: Record<string, string>;
  /** Giọng đọc dùng chung cho mọi nhân vật trong dự án, chọn từ Tài nguyên → Giọng đọc. */
  voice?: string;
  voices?: string[];
  /** Số video nguồn của dự án (không phải số lần lồng tiếng). */
  video_count?: number;
  /** Số video đã có ít nhất 1 bản lồng tiếng. */
  dubbed_count?: number;
  /** Số video chưa lồng tiếng. */
  pending_count?: number;
  videos?: Dubbed[];
  updated_at?: string;
};

/** Kiểu phụ đề Việt in cứng (null = mặc định). Khớp subtitles.py (STYLE_DEFAULTS). */
export type SubStyle = {
  font: string;
  size_pct: number;
  bold: boolean;
  color: string;
  bg: string;
  bg_opacity: number;
  outline: string;
  outline_width: number;
};

export type FontInfo = {
  id: string;
  file: string;
  family: string;
  style: string;
  vi: boolean;
  original_name: string;
  size_kb: number;
  created_at: string;
};

export type DubParams = {
  voice?: string;
  model?: string;
  speed?: number;
  bg_volume?: number;
  delogo?: string;
  subcover?: string;
  burn_sub?: boolean;
  multi_voice?: boolean;
  agy_model?: string;
  sub_style?: SubStyle | null;
};

export type Job = {
  job_id: string;
  status: string;
  pct: number;
  label: string;
  error: string;
  params: DubParams;
};

export type Source = {
  source: string;
  rel_path: string;
  name: string;
  size_mb: number;
  mtime: number;
  duration_sec: number;
  resolution: string;
  project_id: string;
  job: Job | null;
};

export type Dubbed = DubParams & {
  job_id: string;
  title: string;
  mp4_file: string;
  srt_file?: string;
  duration_sec?: number;
  project_id?: string;
  segment_count?: number;
  untranslated?: number;
  cache_mb?: number;
  size_mb?: number;
  updated_at?: string;
};

export type BiliVideo = { local_file: string; title?: string; uploader?: string; delogo?: string };

export type DouyinVideo = {
  aweme_id: string;
  title: string;
  publish_date?: string;
  publish_time?: number;
  duration_sec?: number;
  episode_num?: number | null;
  episode_label?: string;
  cover_url?: string;
  video_url?: string;
  download_url?: string;
  local_file?: string;
  reup_status?: string;
  likes?: number;
  likes_raw?: string;
  comments?: number;
  comments_raw?: string;
  collects?: number;
  collects_raw?: string;
  shares?: number;
  shares_raw?: string;
  _season: "p1" | "p2" | "other";
  _status: "pending" | "downloaded" | "reupped";
};

export type ChannelMeta = { channel_name?: string; douyin_id?: string; channel_url?: string; share_url?: string; total_works?: string };

export type Voice = {
  id: string;
  kind: "clone" | "vieneu";
  name: string;
  gender: string;
  desc?: string;
  slug?: string;
  source?: string;
  f0?: number;
  start?: number;
  end?: number;
  created_at?: string;
};

export type AsrModel = {
  id: string;
  name: string;
  installed: boolean;
  hw: string;
  engine: string;
  vram_gb?: number;
  size_mb: number;
  desc: string;
};
export type VadModel = { id: string; name: string; installed: boolean; desc: string; extra?: string };
export type AsrInfo = { gpu: { cuda?: boolean; name?: string; vram_gb?: number }; models: AsrModel[]; vads: VadModel[]; vad: string };

export type AgyGroup = { base: string; name: string; efforts: { effort: string; id: string }[] };
export type AgyModels = {
  ok?: boolean;
  error?: string;
  fetched_at: string;
  models: { id: string; name: string }[];
  groups: AgyGroup[];
  added?: string[];
  removed?: string[];
};

export type System = { free_gb: number; total_gb: number };
