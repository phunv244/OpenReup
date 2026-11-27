"use client";
import { useEffect, useState } from "react";

/** Vùng đang nhìn thấy của thanh cuộn (gộp theo frame) để chỉ vẽ khối câu & vạch chia trong vùng đó. */
export function useVisibleRange(scroller: React.RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState({ left: 0, width: 1200 });
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      setView((v) => (v.left === sc.scrollLeft && v.width === sc.clientWidth ? v : { left: sc.scrollLeft, width: sc.clientWidth }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(sc);
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scroller]);
  return view;
}
