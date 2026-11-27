"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Đồng bộ vạch phát với <video>. `cur` (state) chỉ cập nhật theo timeupdate ~4 lần/giây cho nút Cắt & đồng hồ;
 * vạch phát thì chạy bằng requestAnimationFrame, ghi thẳng vào DOM để mượt 60fps mà không re-render component.
 */
export function usePlayhead(
  video: React.RefObject<HTMLVideoElement | null>,
  scroller: React.RefObject<HTMLDivElement | null>,
  pxPerSec: number,
) {
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Thời lượng thật của <video>: đọc theo sự kiện, không đọc el.duration lúc vẽ (lúc đó metadata thường chưa có
  // nên timeline từng hiện mốc câu cuối, vd. 5:24, trong khi trình phát ghi 5:26).
  const [mediaDur, setMediaDur] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const pxRef = useRef(pxPerSec);
  pxRef.current = pxPerSec;

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let raf = 0;
    const paint = () => {
      const x = el.currentTime * pxRef.current;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const sc = scroller.current;
      if (sc && !el.paused && (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
    };
    const loop = () => {
      paint();
      raf = requestAnimationFrame(loop);
    };
    const onTime = () => {
      setCur(el.currentTime);
      paint();
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    const onDur = () => setMediaDur(Number.isFinite(el.duration) ? el.duration : 0);
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(raf);
      onTime();
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("durationchange", onDur);
    onDur();
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("durationchange", onDur);
    };
  }, [video, scroller]);
  useEffect(() => {
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${cur * pxPerSec}px)`;
  }, [cur, pxPerSec]);

  return { cur, setCur, playing, playheadRef, mediaDur };
}
