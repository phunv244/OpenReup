"use client";
/**
 * Thanh điều khiển chung cho chế độ so sánh (video gốc | bản đã chỉnh, chia đôi màn).
 * Bản đã chỉnh là video "chủ" (timeline cũng bám theo nó); video gốc chạy theo: play/pause/tua/tốc độ
 * được chép sang, lệch quá 0,25 s thì kéo về. Video xuất giữ đúng mốc giờ gốc nên so khớp 1:1.
 */
import { RefObject, useEffect, useState } from "react";
import { Icon } from "../Icon";

export type CompareAudio = "dub" | "src";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function CompareBar({ master, follower, audio, onAudio, reset }: {
  master: RefObject<HTMLVideoElement | null>;
  follower: RefObject<HTMLVideoElement | null>;
  audio: CompareAudio;
  onAudio: (a: CompareAudio) => void;
  /** Đổi khi video chủ được tạo lại (xuất lại xong) để gắn lại sự kiện. */
  reset: unknown;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    const m = master.current;
    if (!m) return;
    const f = () => follower.current;
    const align = (force = false) => {
      const v = f();
      if (v && v.readyState > 0 && (force || Math.abs(v.currentTime - m.currentTime) > 0.25)) v.currentTime = m.currentTime;
    };
    const onPlay = () => {
      setPlaying(true);
      align(true);
      f()?.play().catch(() => {});
    };
    const onPause = () => {
      setPlaying(false);
      f()?.pause();
      align(true);
    };
    const onTime = () => {
      setT(m.currentTime);
      if (!m.paused) align();
    };
    const onSeek = () => {
      setT(m.currentTime);
      align(true);
    };
    const onRate = () => {
      const v = f();
      if (v) v.playbackRate = m.playbackRate;
    };
    const onMeta = () => setDur(m.duration || 0);
    const onWait = () => f()?.pause(); // video chủ đang tải thì video gốc đứng chờ
    const onPlaying = () => f()?.play().catch(() => {});
    // Video gốc nạp xong sau thì đặt nó về đúng chỗ video chủ đang đứng.
    const fv = f();
    const onFollowerMeta = () => {
      align(true);
      onRate();
      if (!m.paused) fv?.play().catch(() => {});
    };
    onMeta();
    setT(m.currentTime);
    setPlaying(!m.paused);
    onFollowerMeta();
    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("timeupdate", onTime);
    m.addEventListener("seeked", onSeek);
    m.addEventListener("seeking", onSeek);
    m.addEventListener("ratechange", onRate);
    m.addEventListener("loadedmetadata", onMeta);
    m.addEventListener("waiting", onWait);
    m.addEventListener("playing", onPlaying);
    fv?.addEventListener("loadedmetadata", onFollowerMeta);
    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("timeupdate", onTime);
      m.removeEventListener("seeked", onSeek);
      m.removeEventListener("seeking", onSeek);
      m.removeEventListener("ratechange", onRate);
      m.removeEventListener("loadedmetadata", onMeta);
      m.removeEventListener("waiting", onWait);
      m.removeEventListener("playing", onPlaying);
      fv?.removeEventListener("loadedmetadata", onFollowerMeta);
      fv?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset]);

  // Chỉ nghe một tiếng: lồng tiếng hoặc tiếng gốc.
  useEffect(() => {
    if (master.current) master.current.muted = audio === "src";
    if (follower.current) follower.current.muted = audio !== "src";
  }, [audio, reset, master, follower]);
  // Rời chế độ so sánh: trả tiếng cho video chính.
  useEffect(() => () => {
    if (master.current) master.current.muted = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    const m = master.current;
    if (!m) return;
    if (m.paused) m.play().catch(() => {});
    else m.pause();
  };

  return (
    <div className="cmp-bar">
      <button className="icon-btn" type="button" aria-label={playing ? "Tạm dừng cả hai" : "Phát cả hai"} title={playing ? "Tạm dừng cả hai" : "Phát cả hai"} onClick={toggle}>
        <Icon name={playing ? "pause" : "play"} size={16} />
      </button>
      <span className="cmp-time">
        {mmss(t)} / {mmss(dur)}
      </span>
      <input
        className="cmp-seek"
        type="range"
        aria-label="Tua cả hai video"
        min={0}
        max={dur || 0}
        step={0.05}
        value={Math.min(t, dur || 0)}
        onChange={(e) => {
          const m = master.current;
          if (m) m.currentTime = Number(e.target.value);
          setT(Number(e.target.value));
        }}
      />
      <div className="seg cmp-audio" role="group" aria-label="Nghe tiếng">
        {(["dub", "src"] as const).map((a) => (
          <button key={a} type="button" className={audio === a ? "active" : ""} aria-pressed={audio === a} onClick={() => onAudio(a)}>
            <Icon name={a === "dub" ? "mic" : "film"} size={13} /> {a === "dub" ? "Tiếng lồng" : "Tiếng gốc"}
          </button>
        ))}
      </div>
    </div>
  );
}
