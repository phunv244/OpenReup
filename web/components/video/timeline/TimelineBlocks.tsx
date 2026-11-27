"use client";
import { memo } from "react";
import { Edge, Seg, Span, spkIndex } from "./timeline-math";

type Props = {
  items: Seg[];
  from: number;
  to: number;
  pxPerSec: number;
  selected: number | null;
  edits: Record<string, string>;
  spk: Record<string, string>;
  dragId: number | null;
  liveEdge: Span | null;
  onPick: (s: Seg) => void;
  onEdgeDown: (s: Seg, edge: Edge) => (e: React.PointerEvent) => void;
};

/** Layer khối câu tách riêng + memo: vạch phát chạy không làm vẽ lại hàng nghìn khối. */
export const TimelineBlocks = memo(function TimelineBlocks({ items, from, to, pxPerSec, selected, edits, spk, dragId, liveEdge, onPick, onEdgeDown }: Props) {
  const out: React.ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const s = items[i];
    const live = dragId === s.id && liveEdge ? liveEdge : s;
    const isSel = s.id === selected;
    const pendingText = String(s.id) in edits || String(s.id) in spk;
    out.push(
      <div
        key={s.id}
        className={`tl-block spk-${spkIndex(spk[String(s.id)] || s.speaker || "NV1")} ${isSel ? "sel" : ""} ${pendingText ? "edited" : ""}`}
        style={{ left: live.start * pxPerSec, width: Math.max(2, (live.end - live.start) * pxPerSec) }}
        onClick={(e) => {
          e.stopPropagation();
          onPick(s);
        }}
        title={s.vi || s.zh || "(trống)"}
      >
        <span className="tl-handle tl-handle-l" onPointerDown={onEdgeDown(s, "l")} />
        <span className="tl-block-text">{s.vi || s.zh}</span>
        <span className="tl-handle tl-handle-r" onPointerDown={onEdgeDown(s, "r")} />
      </div>,
    );
  }
  return <>{out}</>;
});
