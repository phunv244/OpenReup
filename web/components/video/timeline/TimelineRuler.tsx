"use client";
import { useMemo } from "react";
import { fmtDur } from "@/lib/format";
import { tickStep } from "./timeline-math";

/** Thước thời gian: chỉ vẽ vạch trong vùng đang nhìn thấy [viewFrom, viewTo] (giây). */
export function TimelineRuler({ width, duration, pxPerSec, viewFrom, viewTo }: { width: number; duration: number; pxPerSec: number; viewFrom: number; viewTo: number }) {
  const ticks = useMemo(() => {
    const step = tickStep(pxPerSec);
    const out: number[] = [];
    for (let t = Math.floor(viewFrom / step) * step; t <= Math.min(duration, viewTo); t += step) out.push(t);
    return out;
  }, [duration, pxPerSec, viewFrom, viewTo]);
  return (
    <div className="tl-ruler" style={{ width }}>
      {ticks.map((t) => (
        <span key={t} className="tl-tick" style={{ left: t * pxPerSec }}>
          {fmtDur(t) || "0:00"}
        </span>
      ))}
    </div>
  );
}
