"use client";
/**
 * Timeline cắt-ghép câu thoại kiểu CapCut: khối = 1 câu, kéo mép để chỉnh mốc giờ, cắt/ghép/xóa áp dụng ngay
 * (cần "Lưu & xuất lại" để thấy trên video), sửa lời/người nói dùng chung `edits`/`spk` với bảng tìm kiếm bên dưới.
 * Logic tách trong ./timeline: vạch phát (usePlayhead), vùng nhìn thấy (useVisibleRange), kéo mép (useEdgeDrag),
 * cắt/ghép/xóa (useSegmentOps), lớp khối (TimelineBlocks), thước (TimelineRuler), ô sửa câu (SegmentDetail).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Speaker, getJSON } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import { Icon } from "../Icon";
import { useToast } from "../Toasts";
import { SegmentDetail } from "./timeline/SegmentDetail";
import { TimelineBlocks } from "./timeline/TimelineBlocks";
import { TimelineRuler } from "./timeline/TimelineRuler";
import { MAX_PX_SEC, MIN_PX_SEC, OVERSCAN_PX, Outline, Seg, firstEndingAfter } from "./timeline/timeline-math";
import { useEdgeDrag } from "./timeline/useEdgeDrag";
import { usePlayhead } from "./timeline/usePlayhead";
import { useSegmentOps } from "./timeline/useSegmentOps";
import { useVisibleRange } from "./timeline/useVisibleRange";

type Props = {
  jobId: string;
  video: React.RefObject<HTMLVideoElement | null>;
  speakers: [string, Speaker][];
  edits: Record<string, string>;
  setEdits: (m: Record<string, string>) => void;
  spk: Record<string, string>;
  setSpk: (m: Record<string, string>) => void;
  /** Báo bảng "Lời thoại" tải lại sau khi cắt/ghép/xóa; `patch` ghi đè bản sửa chưa lưu của các câu còn lại. */
  onStructuralChange: (removedIds: number[], patch?: Record<string, string>) => void;
  /** Nơi hiện ô sửa "câu đang chọn" (vd. panel bên phải của studio); không có thì hiện ngay dưới timeline. */
  detailHost?: HTMLElement | null;
  /** Gọi khi chọn 1 khối — trang cha dùng để mở đúng tab lời thoại. */
  onSelect?: () => void;
  /** Tắt phím cách phát/dừng (vd. đang ở tab "Hình & phụ đề", khung video bị ẩn — phát sẽ chỉ nghe tiếng mà không thấy hình). */
  spaceOff?: boolean;
};

export function TimelineEditor({ jobId, video, speakers, edits, setEdits, spk, setSpk, onStructuralChange, detailHost, onSelect, spaceOff = false }: Props) {
  const toast = useToast();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pxPerSec, setPxPerSec] = useState(30);
  const scroller = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const view = useVisibleRange(scroller);
  const { cur, setCur, playing, playheadRef, mediaDur } = usePlayhead(video, scroller, pxPerSec);

  const load = useCallback(async () => {
    const d = await getJSON<Outline & { error?: string }>(`/api/dub/outline?id=${encodeURIComponent(jobId)}`);
    if (d.error) return;
    setOutline(d);
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load]);

  const items = outline?.items || [];
  const duration = Math.max(mediaDur, items.length ? items[items.length - 1].end : 0, 30);
  const width = Math.max(600, duration * pxPerSec);
  const sel = items.find((s) => s.id === selected) || null;

  const { drag, liveEdge, onEdgeDown, onEdgeMove, onEdgeUp, cancel } = useEdgeDrag({
    jobId,
    items,
    duration,
    pxPerSec,
    trackRef,
    setSelected,
    onSaved: async (error) => {
      if (error) toast(error, "error");
      else onStructuralChange([]);
      await load();
    },
  });
  const ops = useSegmentOps({ jobId, items, sel, cur, edits, toast, onStructuralChange, clearSelection: () => setSelected(null), reload: load });

  const zoom = (factor: number) => {
    const sc = scroller.current;
    const next = Math.min(MAX_PX_SEC, Math.max(MIN_PX_SEC, pxPerSec * factor));
    setPxPerSec(next);
    // Giữ vạch phát ở nguyên vị trí trên màn hình khi phóng/thu.
    if (sc) {
      const offset = cur * pxPerSec - sc.scrollLeft;
      requestAnimationFrame(() => (sc.scrollLeft = Math.max(0, cur * next - offset)));
    }
  };
  const togglePlay = () => {
    const el = video.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  };
  // Phím cách = phát/dừng ở mọi chỗ trên trang, trừ khi đang gõ chữ hoặc đang đứng trên một nút/ô chọn.
  const toggleRef = useRef(togglePlay);
  toggleRef.current = togglePlay;
  const spaceOffRef = useRef(spaceOff);
  spaceOffRef.current = spaceOff;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (spaceOffRef.current || e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, button, a, [contenteditable=true], [role=menu], [role=listbox]")) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const clickTrack = (e: React.MouseEvent) => {
    const el = video.current;
    if (drag || !el) return;
    const r = trackRef.current!.getBoundingClientRect();
    el.currentTime = Math.max(0, (e.clientX - r.left) / pxPerSec);
    setCur(el.currentTime);
  };

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const pick = useCallback(
    (s: Seg) => {
      setSelected(s.id);
      onSelectRef.current?.();
      const el = video.current;
      if (el) {
        el.currentTime = s.start;
        setCur(s.start);
      }
    },
    [video, setCur],
  );

  // Chỉ vẽ khối trong vùng nhìn thấy (+ đệm); khối đang kéo luôn được vẽ dù đã ra ngoài (giữ pointer capture).
  const viewFrom = Math.max(0, (view.left - OVERSCAN_PX) / pxPerSec);
  const viewTo = (view.left + view.width + OVERSCAN_PX) / pxPerSec;
  const from = firstEndingAfter(items, viewFrom);
  let to = from;
  while (to < items.length && items[to].start <= viewTo) to++;
  const dragIdx = drag ? items.findIndex((s) => s.id === drag.id) : -1;
  const vFrom = dragIdx >= 0 ? Math.min(from, dragIdx) : from;
  const vTo = dragIdx >= 0 ? Math.max(to, dragIdx + 1) : to;

  const detail = sel ? (
    <SegmentDetail sel={sel} speakers={speakers} edits={edits} setEdits={setEdits} spk={spk} setSpk={setSpk} onClose={() => setSelected(null)} />
  ) : null;

  return (
    <div className="tl-wrap">
      <div className="tl-toolbar">
        <button className="btn btn-light btn-sm" type="button" onClick={togglePlay} title="Phát / dừng (phím cách)" aria-label="Phát / dừng">
          <Icon name={playing ? "pause" : "play"} size={15} />
        </button>
        <span className="tl-time muted">
          {fmtDur(cur) || "0:00"} / {fmtDur(duration)}
        </span>
        <span className="grow" />
        <button className="btn btn-quiet btn-sm" type="button" disabled={!ops.canSplit} title="Cắt câu tại vị trí đang xem" onClick={ops.split}>
          <Icon name="scissors" size={15} /> Cắt
        </button>
        <button className="btn btn-quiet btn-sm" type="button" disabled={!ops.canMergeNext} title="Ghép với câu kế tiếp" onClick={ops.mergeNext}>
          <Icon name="merge" size={15} /> Ghép
        </button>
        <button className="btn btn-quiet btn-sm" type="button" disabled={!sel} title="Xóa câu" onClick={ops.remove}>
          <Icon name="trash" size={15} /> Xóa
        </button>
        <button className="btn btn-quiet btn-sm" type="button" title="Thu nhỏ" onClick={() => zoom(1 / 1.5)}>
          <Icon name="zoomOut" size={15} />
        </button>
        <button className="btn btn-quiet btn-sm" type="button" title="Phóng to" onClick={() => zoom(1.5)}>
          <Icon name="zoomIn" size={15} />
        </button>
      </div>

      <div className="tl-scroll" ref={scroller}>
        <TimelineRuler width={width} duration={duration} pxPerSec={pxPerSec} viewFrom={viewFrom} viewTo={viewTo} />
        <div className="tl-track" ref={trackRef} style={{ width }} onClick={clickTrack} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp} onPointerCancel={cancel}>
          {!outline ? (
            <div className="tl-loading muted">Đang tải timeline…</div>
          ) : (
            <TimelineBlocks
              items={items}
              from={vFrom}
              to={vTo}
              pxPerSec={pxPerSec}
              selected={selected}
              edits={edits}
              spk={spk}
              dragId={drag?.id ?? null}
              liveEdge={liveEdge}
              onPick={pick}
              onEdgeDown={onEdgeDown}
            />
          )}
          <div className="tl-playhead" ref={playheadRef} />
        </div>
      </div>
      {outline?.truncated && (
        <div className="help">Video này có hơn {outline.total.toLocaleString("vi")} câu — timeline chỉ vẽ 4000 câu đầu, dùng ô tìm kiếm trong danh sách lời thoại cho các câu còn lại.</div>
      )}

      {sel && (detailHost ? createPortal(detail, detailHost) : detail)}
    </div>
  );
}
