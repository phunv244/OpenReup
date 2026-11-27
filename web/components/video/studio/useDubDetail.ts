"use client";
/**
 * Trạng thái màn chỉnh một bản lồng tiếng: nạp thông số đã lưu, giữ bản sửa chưa lưu (lời, nhân vật, giọng, hình),
 * tính mức làm lại nhỏ nhất (chỉ hình / chỉ tiếng / cả hai / làm lại theo timeline mới) và gửi "Lưu & chạy lại".
 */
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toasts";
import { regionInit } from "@/components/video/FrameStage";
import { Speaker, SubStyle, getJSON } from "@/lib/api";
import { useStudio } from "@/lib/studio";

export type DubInfo = {
  error?: string;
  title: string;
  voice: string;
  bg_volume?: number;
  delogo?: string;
  subcover?: string;
  sub_style?: SubStyle | null;
  burn_sub?: boolean;
  input_path?: string;
  project_id?: string;
  multi_voice?: boolean;
  speakers?: Record<string, Speaker>;
  speed?: number;
  resolution?: string;
  total: number;
  empty: number;
  timeline_dirty?: boolean;
};

export type Plan = "full" | "both" | "video" | "audio" | "";

export const PLAN_TEXT: Record<Exclude<Plan, "">, string> = {
  full: "Timeline đã đổi (cắt/ghép/xóa/dời câu) — làm lại cả hình và tiếng theo mốc mới.",
  video: "Chỉ mã hóa lại hình — giữ nguyên tiếng đã xuất, không tạo lại giọng đọc.",
  audio: "Chỉ dựng lại tiếng — giữ nguyên hình đã xuất, không mã hóa lại video.",
  both: "Làm lại cả hình và tiếng — chỉ đọc lại câu đã sửa, phần không đổi dùng lại từ cache.",
};

const nz = (s?: string) => s || "none";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function useDubDetail(jobId: string) {
  const toast = useToast();
  const { dubbed, task, startTask } = useStudio();
  const [info, setInfo] = useState<DubInfo | null>(null);
  const [loadError, setLoadError] = useState(""); // không đọc được bản lồng tiếng (sai mã / đã xóa): trang báo lỗi thay vì "Đang tải..." mãi
  const [voice, setVoice] = useState("");
  const [spkVoices, setSpkVoices] = useState<Record<string, string>>({});
  const [bg, setBg] = useState("0.05");
  const [sub, setSub] = useState(true);
  const [delogo, setDelogo] = useState("none");
  const [subcover, setSubcover] = useState("none");
  const [subStyle, setSubStyle] = useState<SubStyle | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({}); // {id: lời mới}
  const [spk, setSpk] = useState<Record<string, string>>({}); // {id: nhân vật mới}
  const [structural, setStructural] = useState(false); // đã cắt/ghép/xóa/dời giờ câu, chưa xuất lại
  const [tableKey, setTableKey] = useState(0);
  const [stamp, setStamp] = useState(0); // đổi để tải lại sau khi xuất lại xong / hoàn tác

  const d = dubbed.find((x) => x.job_id === jobId);
  const running = Boolean(task?.running && task.target === jobId);

  // Đổi video: bỏ số liệu/lỗi của video trước ngay (không reset khi chỉ tải lại cùng video sau xuất lại).
  useEffect(() => {
    setInfo(null);
    setLoadError("");
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    let stale = false; // đổi job/tải lại nhanh: bỏ kết quả của lần tải cũ về sau, không cho đè dữ liệu mới
    getJSON<DubInfo>(`/api/dub/segments?id=${encodeURIComponent(jobId)}&limit=1`).then((r) => {
      if (stale) return;
      if (r.error) {
        setLoadError(r.error);
        return toast(r.error, "error");
      }
      setLoadError("");
      setInfo(r);
      setVoice(r.voice);
      setBg(String(r.bg_volume ?? 0.05));
      setSub(r.burn_sub !== false);
      setSubStyle(r.sub_style || null);
      setDelogo(regionInit(r.delogo));
      setSubcover(regionInit(r.subcover));
      setSpkVoices({});
      setEdits({});
      setSpk({});
      setStructural(Boolean(r.timeline_dirty));
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, stamp]);

  // Xuất lại xong (updated_at đổi) thì nạp lại giá trị đã lưu và làm mới video đang phát.
  const doneKey = `${d?.updated_at || ""}`;
  useEffect(() => setStamp((s) => s + 1), [doneKey]);

  const editCount = new Set([...Object.keys(edits), ...Object.keys(spk)]).size;
  // Còn bản sửa chưa xuất lại mà rời trang thì hỏi lại.
  useEffect(() => {
    if (!editCount) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editCount]);

  const speakers = Object.entries(info?.multi_voice ? info.speakers || {} : {});
  const settingsVideoDirty = Boolean(
    info &&
      (sub !== (info.burn_sub !== false) ||
        nz(delogo) !== nz(info.delogo) ||
        nz(subcover) !== nz(info.subcover) ||
        !same(sub ? subStyle : null, info.burn_sub === false ? null : info.sub_style))
  );
  const settingsAudioDirty = Boolean(
    info && (voice !== info.voice || Number(bg) !== Number(info.bg_volume ?? 0.05) || Object.entries(spkVoices).some(([k, v]) => v !== info.speakers?.[k]?.voice))
  );
  const textEdits = Object.keys(edits).length > 0;
  const videoDirty = settingsVideoDirty || (textEdits && sub);
  const audioDirty = settingsAudioDirty || editCount > 0;
  const plan: Plan = structural ? "full" : videoDirty && audioDirty ? "both" : videoDirty ? "video" : audioDirty ? "audio" : "";
  const summary = [
    editCount ? `sửa ${editCount} câu` : "",
    structural ? "đổi timeline" : "",
    settingsAudioDirty ? "đổi giọng/âm thanh" : "",
    settingsVideoDirty ? "đổi hình/phụ đề" : "",
  ].filter(Boolean);

  const onStructuralChange = (removedIds: number[], patch: Record<string, string> = {}) => {
    const drop = new Set(removedIds.map(String));
    setEdits((m) => ({ ...Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k))), ...patch }));
    setSpk((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k))));
    setStructural(true);
    setTableKey((k) => k + 1);
  };

  async function save() {
    if (!info) return;
    if (!delogo) return toast("Hãy kéo chuột trên khung hình để khoanh vùng logo", "error");
    if (!subcover) return toast("Hãy kéo chuột trên khung hình để khoanh vùng phụ đề gốc", "error");
    const body: Record<string, unknown> = { job_id: jobId };
    if (textEdits) body.edits = edits;
    if (Object.keys(spk).length) body.speaker_edits = spk;
    if (settingsVideoDirty) Object.assign(body, { delogo, subcover, sub_style: sub ? subStyle : null, burn_sub: sub });
    if (settingsAudioDirty) {
      Object.assign(body, { voice, bg_volume: Number(bg) });
      const sv = Object.fromEntries(Object.entries(spkVoices).filter(([k, v]) => v !== info.speakers?.[k]?.voice));
      if (Object.keys(sv).length) body.speaker_voices = sv;
    }
    const ok = await startTask("/api/dub/rerender", body, plan === "video" ? "Đang mã hóa lại hình" : plan === "audio" ? "Đang dựng lại tiếng" : "Đang xuất lại");
    if (!ok) return;
    // Server đã ghi lời/nhân vật vào DB: bỏ dấu "chưa lưu" và nạp lại bảng từ server.
    setEdits({});
    setSpk({});
    setTableKey((k) => k + 1);
  }

  return {
    info, loadError, d, running, speakers,
    voice, setVoice, spkVoices, setSpkVoices, bg, setBg,
    sub, setSub, delogo, setDelogo, subcover, setSubcover, subStyle, setSubStyle,
    edits, setEdits, spk, setSpk, structural, editCount, tableKey, stamp,
    settingsVideoDirty, settingsAudioDirty, plan, summary,
    onStructuralChange, save,
    /** Bỏ mọi thay đổi chưa lưu: nạp lại từ server. */
    reset: () => setStamp((s) => s + 1),
  };
}

export type DubDetail = ReturnType<typeof useDubDetail>;
