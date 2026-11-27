"use client";
import { useCallback, useState } from "react";
import { postJSON } from "@/lib/api";
import { Edge, Seg, Span } from "./timeline-math";

type Opts = {
  jobId: string;
  items: Seg[];
  duration: number;
  pxPerSec: number;
  trackRef: React.RefObject<HTMLDivElement | null>;
  setSelected: (id: number) => void;
  /** Gọi sau khi lưu mốc giờ: `error` có giá trị khi server từ chối. */
  onSaved: (error?: string) => Promise<void>;
};

/** Kéo mép khối để chỉnh mốc giờ: không vượt sang câu kề, câu tối thiểu 0,1 giây; thả tay mới lưu. */
export function useEdgeDrag({ jobId, items, duration, pxPerSec, trackRef, setSelected, onSaved }: Opts) {
  const [drag, setDrag] = useState<{ id: number; edge: Edge; startStart: number; startEnd: number } | null>(null);
  const [liveEdge, setLiveEdge] = useState<Span | null>(null);

  const onEdgeDown = useCallback(
    (s: Seg, edge: Edge) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      setSelected(s.id);
      setDrag({ id: s.id, edge, startStart: s.start, startEnd: s.end });
    },
    [setSelected],
  );

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
    await onSaved(d.error);
  };

  const cancel = () => {
    setDrag(null);
    setLiveEdge(null);
  };

  return { drag, liveEdge, onEdgeDown, onEdgeMove, onEdgeUp, cancel };
}
