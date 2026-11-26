"use client";
/**
 * Timeline cắt-ghép câu thoại kiểu CapCut: khối = 1 câu, kéo mép để chỉnh mốc giờ, cắt/ghép/xóa áp dụng ngay
 * (cần "Lưu & xuất lại" để thấy trên video), sửa lời/người nói dùng chung `edits`/`spk` với bảng tìm kiếm bên dưới.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Speaker, getJSON, postJSON } from "@/lib/api";
import { setMap } from "@/lib/editMap";
import { fmtDur } from "@/lib/format";
import { Icon } from "../Icon";
import { Options } from "../ui";
import { useToast } from "../Toasts";

type Seg = { id: number; start: number; end: number; zh: string; vi: string; speaker: string };
type Outline = { total: number; truncated: boolean; items: Seg[] };

const spkIndex = (k: string) => Number(String(k).replace(/\D/g, "")) || 1;
const MIN_PX_SEC = 4;
const MAX_PX_SEC = 240;

type Props = {
  jobId: string;
  video: React.RefObject<HTMLVideoElement | null>;
  speakers: [string, Speaker][];
  edits: Record<string, string>;
  setEdits: (m: Record<string, string>) => void;
  spk: Record<string, string>;
  setSpk: (m: Record<string, string>) => void;
  onStructuralChange: (removedIds: number[]) => void;
};

export function TimelineEditor({ jobId, video, speakers, edits, setEdits, spk, setSpk, onStructuralChange }: Props) {
  const toast = useToast();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [cur, setCur] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(30);
  const [drag, setDrag] = useState<{ id: number; edge: "l" | "r"; startStart: number; startEnd: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const spkKeys = speakers.map(([k]) => k);

  const load = useCallback(async () => {
    const d = await getJSON<Outline & { error?: string }>(`/api/dub/outline?id=${encodeURIComponent(jobId)}`);
    if (d.error) return;
    setOutline(d);
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load]);

  // Theo dõi vị trí phát để vẽ vạch & tự cuộn theo.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onTime = () => setCur(el.currentTime);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
    };
  }, [video]);
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const x = cur * pxPerSec;
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
  }, [cur, pxPerSec]);

  const items = outline?.items || [];
  const duration = Math.max(video.current?.duration || 0, items.length ? items[items.length - 1].end : 0, 30);
  const width = Math.max(600, duration * pxPerSec);
  const sel = items.find((s) => s.id === selected) || null;

  const seekTo = (sec: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    setCur(el.currentTime);
  };
  const togglePlay = () => {
    const el = video.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  };

  const clickTrack = (e: React.MouseEvent) => {
    if (drag) return;
    const r = trackRef.current!.getBoundingClientRect();
    seekTo((e.clientX - r.left) / pxPerSec);
  };

  /* ---- kéo mép khối để chỉnh mốc giờ ---- */
  const onEdgeDown = (s: Seg, edge: "l" | "r") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setSelected(s.id);
    setDrag({ id: s.id, edge, startStart: s.start, startEnd: s.end });
  };
  const [liveEdge, setLiveEdge] = useState<{ start: number; end: number } | null>(null);
  const onEdgeMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const r = trackRef.current!.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - r.left) / pxPerSec);
    const idx = items.findIndex((s) => s.id === drag.id);
    const prev = items[idx - 1];
    const next = items[idx + 1];
    if (drag.edge === "l") {
      const lo = prev ? prev.end : 0;
      setLiveEdge({ start: Math.min(Math.max(lo, t), drag.startEnd - 0.1), end: drag.startEnd });
    } else {
      const hi = next ? next.start : duration;
      setLiveEdge({ start: drag.startStart, end: Math.max(Math.min(hi, t), drag.startStart + 0.1) });
    }
  };
  const onEdgeUp = async () => {
    if (!drag || !liveEdge) {
      setDrag(null);
      return;
    }
    const d = await postJSON(`/api/dub/segment/update`, { job_id: jobId, id: drag.id, start: liveEdge.start, end: liveEdge.end });
    setDrag(null);
    setLiveEdge(null);
    if (d.error) toast(d.error, "error");
    await load();
  };

  const canSplit = sel && cur > sel.start + 0.05 && cur < sel.end - 0.05;
  const idxOfSel = sel ? items.findIndex((s) => s.id === sel.id) : -1;
  const canMergeNext = idxOfSel >= 0 && idxOfSel < items.length - 1;

  async function split() {
    if (!sel) return;
    const d = await postJSON("/api/dub/segment/split", { job_id: jobId, id: sel.id, at: cur });
    if (d.error) return toast(d.error, "error");
    toast("Đã cắt câu — câu sau để trống, gõ lại lời rồi Lưu & xuất lại.", "success");
    await load();
  }
  async function mergeNext() {
    if (!sel || !canMergeNext) return;
    const withId = items[idxOfSel + 1].id;
    const d = await postJSON("/api/dub/segment/merge", { job_id: jobId, id: sel.id, with_id: withId });
    if (d.error) return toast(d.error, "error");
    onStructuralChange([withId]);
    toast("Đã ghép 2 câu.", "success");
    await load();
  }
  async function delSeg() {
    if (!sel) return;
    if (!confirm(`Xóa câu ${fmtDur(sel.start)}? Chỉ xóa dòng lời, cần "Lưu & xuất lại" để video khớp lại.`)) return;
    const d = await postJSON("/api/dub/segment/delete", { job_id: jobId, id: sel.id });
    if (d.error) return toast(d.error, "error");
    onStructuralChange([sel.id]);
    setSelected(null);
    toast("Đã xóa câu.", "success");
    await load();
  }

  const ticks = useMemo(() => {
    const step = pxPerSec > 60 ? 5 : pxPerSec > 20 ? 10 : pxPerSec > 8 ? 30 : 60;
    const out: number[] = [];
    for (let t = 0; t <= duration; t += step) out.push(t);
    return out;
  }, [duration, pxPerSec]);

  return (
    <div className="tl-wrap">
      <div className="tl-toolbar">
        <button className="btn btn-light btn-sm" type="button" onClick={togglePlay} title="Phát / dừng">
          <Icon name={video.current && !video.current.paused ? "pause" : "play"} size={15} />
        </button>
        <span className="tl-time muted">
          {fmtDur(cur) || "0:00"} / {fmtDur(duration)}
        </span>
        <span className="grow" />
        <button className="btn btn-quiet btn-sm" type="button" disabled={!canSplit} title="Cắt câu tại vị trí đang xem" onClick={split}>
          <Icon name="scissors" size={15} /> Cắt
        </button>
        <button className="btn btn-quiet btn-sm" type="button" disabled={!canMergeNext} title="Ghép với câu kế tiếp" onClick={mergeNext}>
          <Icon name="merge" size={15} /> Ghép
        </button>
        <button className="btn btn-quiet btn-sm" type="button" disabled={!sel} title="Xóa câu" onClick={delSeg}>
          <Icon name="trash" size={15} /> Xóa
        </button>
        <button className="btn btn-quiet btn-sm" type="button" title="Thu nhỏ" onClick={() => setPxPerSec((p) => Math.max(MIN_PX_SEC, p / 1.5))}>
          <Icon name="zoomOut" size={15} />
        </button>
        <button className="btn btn-quiet btn-sm" type="button" title="Phóng to" onClick={() => setPxPerSec((p) => Math.min(MAX_PX_SEC, p * 1.5))}>
          <Icon name="zoomIn" size={15} />
        </button>
      </div>

      <div className="tl-scroll" ref={scroller}>
        <div className="tl-ruler" style={{ width }}>
          {ticks.map((t) => (
            <span key={t} className="tl-tick" style={{ left: t * pxPerSec }}>
              {fmtDur(t) || "0:00"}
            </span>
          ))}
        </div>
        <div
          className="tl-track"
          ref={trackRef}
          style={{ width }}
          onClick={clickTrack}
          onPointerMove={onEdgeMove}
          onPointerUp={onEdgeUp}
          onPointerCancel={() => (setDrag(null), setLiveEdge(null))}
        >
          {!outline ? (
            <div className="tl-loading muted">Đang tải timeline…</div>
          ) : (
            items.map((s) => {
              const live = drag?.id === s.id && liveEdge ? liveEdge : s;
              const isSel = s.id === selected;
              const pendingText = String(s.id) in edits || String(s.id) in spk;
              return (
                <div
                  key={s.id}
                  className={`tl-block spk-${spkIndex(spk[String(s.id)] || s.speaker || "NV1")} ${isSel ? "sel" : ""} ${pendingText ? "edited" : ""}`}
                  style={{ left: live.start * pxPerSec, width: Math.max(2, (live.end - live.start) * pxPerSec) }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(s.id);
                    seekTo(s.start);
                  }}
                  title={s.vi || s.zh || "(trống)"}
                >
                  <span className="tl-handle tl-handle-l" onPointerDown={onEdgeDown(s, "l")} />
                  <span className="tl-block-text">{s.vi || s.zh}</span>
                  <span className="tl-handle tl-handle-r" onPointerDown={onEdgeDown(s, "r")} />
                </div>
              );
            })
          )}
          <div className="tl-playhead" style={{ left: cur * pxPerSec }} />
        </div>
      </div>
      {outline?.truncated && (
        <div className="help">Video này có hơn {outline.total.toLocaleString("vi")} câu — timeline chỉ vẽ 4000 câu đầu, dùng bảng tìm kiếm bên dưới cho các câu còn lại.</div>
      )}

      {sel && (
        <div className="tl-detail">
          <div className="tl-detail-head">
            <span className="muted">
              {fmtDur(sel.start)} – {fmtDur(sel.end)}
            </span>
            {spkKeys.length > 0 && (
              <select
                className="select input-sm"
                aria-label="Người nói"
                value={spk[String(sel.id)] || sel.speaker || "NV1"}
                onChange={(e) => setMap(spk, setSpk, String(sel.id), e.target.value, sel.speaker || "NV1")}
              >
                <Options list={speakers.map(([k, s]) => [k, s.name ? `${k} · ${s.name}` : k])} />
              </select>
            )}
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setSelected(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="tl-detail-zh muted">{sel.zh || "(không có lời gốc)"}</div>
          <textarea
            className="input tl-detail-vi"
            rows={2}
            aria-label="Lời Việt"
            value={String(sel.id) in edits ? edits[String(sel.id)] : sel.vi}
            onChange={(e) => {
              const next = { ...edits };
              if (e.target.value.trim() !== sel.vi) next[String(sel.id)] = e.target.value;
              else delete next[String(sel.id)];
              setEdits(next);
            }}
          />
        </div>
      )}
    </div>
  );
}
