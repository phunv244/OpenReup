"use client";
/**
 * Dữ liệu dùng chung toàn app: tiến trình nền (hỏi server 2,5 giây/lần) + dữ liệu dự án/video/giọng/mô hình.
 * Component nào cần thì gọi useStudio(); dữ liệu đổi là giao diện tự vẽ lại.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toasts";
import {
  AsrInfo, BiliVideo, ChannelMeta, DouyinVideo, Dubbed, FontInfo, Project, Source, System, TaskState, Voice, getJSON, postJSON,
} from "./api";
import { normalizeVideo } from "./douyin";
import { taskName } from "./format";

type Data = {
  projects: Project[];
  sources: Source[];
  dubbed: Dubbed[];
  bili: BiliVideo[];
  videos: DouyinVideo[];
  channel: ChannelMeta;
  douyinUpdatedAt: string;
  system: System;
  voices: { clones: Voice[]; presets: Voice[] };
  asr: AsrInfo;
  fonts: FontInfo[];
  systemFonts: string[]; // họ font tiếng Việt có sẵn trong máy
};

type StartResult = { ok?: boolean; error?: string; queued?: boolean; position?: number };

type Studio = Data & {
  loaded: boolean;
  task: TaskState | null;
  reload: () => Promise<void>;
  /** Cập nhật 1 dự án tại chỗ (sau khi lưu) mà không phải tải lại tất cả. */
  patchProject: (p: Project) => void;
  /** Gọi API bắt đầu tác vụ; tự báo "đã xếp hàng" nếu server đang bận. */
  startTask: (url: string, body: unknown, okMsg: string) => Promise<boolean>;
  stopTask: () => Promise<void>;
  unqueue: (id: number) => Promise<void>;
};

const EMPTY: Data = {
  projects: [],
  sources: [],
  dubbed: [],
  bili: [],
  videos: [],
  channel: {},
  douyinUpdatedAt: "",
  system: { free_gb: 0, total_gb: 0 },
  voices: { clones: [], presets: [] },
  asr: { gpu: {}, models: [], vads: [], vad: "" },
  fonts: [],
  systemFonts: [],
};
const StudioContext = createContext<Studio | null>(null);

export function useStudio() {
  const s = useContext(StudioContext);
  if (!s) throw new Error("useStudio phải nằm trong <StudioProvider>");
  return s;
}

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [data, setData] = useState<Data>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [task, setTask] = useState<TaskState | null>(null);
  const lastEnded = useRef<number | null>(null); // ended_at của tác vụ xong gần nhất đã báo
  const tick = useRef(0);

  const reload = useCallback(
    async () => {
      try {
        const [vd, bili, dubbed, sources, projects, system, voices, asr, fonts] = await Promise.all([
          getJSON<{ videos?: Omit<DouyinVideo, "_season" | "_status">[]; channel_meta?: ChannelMeta; updated_at?: string }>("/api/videos"),
          getJSON<{ videos?: BiliVideo[] }>("/api/bilibili"),
          getJSON<{ videos?: Dubbed[] }>("/api/dubbed"),
          getJSON<{ sources?: Source[] }>("/api/sources"),
          getJSON<{ projects?: Project[] }>("/api/projects"),
          getJSON<System>("/api/system"),
          getJSON<{ clones?: Voice[]; presets?: Voice[] }>("/api/voices"),
          getJSON<Partial<AsrInfo>>("/api/asr-models").catch(() => ({}) as Partial<AsrInfo>),
          getJSON<{ fonts?: FontInfo[]; system?: string[] }>("/api/fonts").catch(() => ({}) as { fonts?: FontInfo[]; system?: string[] }),
        ]);
        setData({
          videos: (vd.videos || []).map(normalizeVideo),
          channel: vd.channel_meta || {},
          douyinUpdatedAt: vd.updated_at || "",
          bili: bili.videos || [],
          dubbed: dubbed.videos || [],
          sources: sources.sources || [],
          projects: projects.projects || [],
          system,
          voices: { clones: voices.clones || [], presets: voices.presets || [] },
          asr: { gpu: asr.gpu || {}, models: asr.models || [], vads: asr.vads || [], vad: asr.vad || "" },
          fonts: fonts.fonts || [],
          systemFonts: fonts.system || [],
        });
        setLoaded(true);
      } catch {
        toast("Không tải được dữ liệu từ máy chủ", "error");
      }
    },
    [toast]
  );

  const pollTask = useCallback(async () => {
    let t: TaskState;
    try {
      t = await getJSON<TaskState>("/api/task");
    } catch {
      return;
    }
    setTask(t);
    // Đang chạy: làm mới dữ liệu 10 giây/lần để thấy video vừa tải, % job đang dở...
    if (t.running && ++tick.current % 4 === 0) reload();
    // Báo từng tác vụ vừa xong (hàng đợi chạy tiếp ngay nên không dựa vào running chuyển sang false).
    const hist = t.history || [];
    if (lastEnded.current !== null) {
      const done = hist.filter((h) => h.ended_at > (lastEnded.current as number)).reverse();
      if (done.length) reload();
      for (const h of done) {
        const name = taskName(h.type);
        if (h.exit_code === 0) toast(`${name}: hoàn tất`, "success");
        else if (h.exit_code === 130 || h.exit_code == null) toast(`${name}: đã dừng, tiến độ được lưu lại`);
        else toast(`${name}: gặp lỗi — mở Nhật ký để xem chi tiết`, "error");
      }
    }
    lastEnded.current = hist[0]?.ended_at || 0;
  }, [reload, toast]);

  useEffect(() => {
    reload();
    pollTask();
    // Hỏi trạng thái tác vụ mỗi 2,5 s, nhưng bỏ qua khi tab đang ẩn; quay lại tab thì hỏi ngay.
    const id = setInterval(() => document.visibilityState === "visible" && pollTask(), 2500);
    // Tự làm mới khi quay lại tab/cửa sổ (thay nút "Làm mới"): file có thể đã đổi ngoài app. Tối đa 1 lần / 5 giây.
    let last = Date.now();
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      pollTask();
      if (Date.now() - last < 5000) return;
      last = Date.now();
      reload();
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [reload, pollTask]);

  const startTask = useCallback(
    async (url: string, body: unknown, okMsg: string) => {
      const d = await postJSON<StartResult>(url, body);
      if (!d.ok) {
        toast(d.error || "Không thể bắt đầu tiến trình", "error");
        return false;
      }
      toast(d.queued ? `Đã thêm vào hàng đợi (thứ ${d.position})` : okMsg, "success");
      await pollTask();
      return true;
    },
    [pollTask, toast]
  );

  const stopTask = useCallback(async () => {
    await postJSON("/api/task/stop");
    toast("Đang dừng tiến trình...");
    pollTask();
  }, [pollTask, toast]);

  const unqueue = useCallback(
    async (id: number) => {
      await postJSON("/api/task/queue/remove", { id });
      pollTask();
    },
    [pollTask]
  );

  const patchProject = useCallback(
    (p: Project) => setData((d) => ({ ...d, projects: d.projects.map((x) => (x.id === p.id ? { ...x, ...p } : x)) })),
    []
  );

  return (
    <StudioContext.Provider value={{ ...data, loaded, task, reload, patchProject, startTask, stopTask, unqueue }}>
      {children}
    </StudioContext.Provider>
  );
}
