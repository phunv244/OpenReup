"use client";
/** Sân khấu lớn: phát bản đã xuất, khung hình tĩnh để xem trước/khoanh vùng, hoặc so sánh gốc | đã chỉnh chia đôi. */
import Link from "next/link";
import { RefObject, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { CompareAudio, CompareBar } from "@/components/video/CompareBar";
import { FrameStage, RegionTarget } from "@/components/video/FrameStage";
import { dubFileUrl, fileUrl } from "@/lib/api";
import { projHref } from "@/lib/format";
import type { DubDetail } from "./useDubDetail";

export type StageView = "video" | "frame" | "compare";

type Props = {
  s: DubDetail;
  jobId: string;
  pid: string;
  view: StageView;
  setView: (v: StageView | ((v: StageView) => StageView)) => void;
  video: RefObject<HTMLVideoElement | null>;
  target: RegionTarget | null;
  setTarget: (t: RegionTarget | null) => void;
};

export function Stage({ s, jobId, pid, view, setView, video, target, setTarget }: Props) {
  const { info, d, sub, subStyle, delogo, subcover, setDelogo, setSubcover, stamp } = s;
  const srcVideo = useRef<HTMLVideoElement>(null);
  const [cmpAudio, setCmpAudio] = useState<CompareAudio>("dub");
  if (!info) return null;
  // Video nguồn (chưa lồng tiếng) phục vụ tĩnh dưới /downloads/...
  const inputPath = info.input_path || "";
  const srcUrl = inputPath.includes("downloads/") ? fileUrl(inputPath.slice(inputPath.lastIndexOf("downloads/"))) : "";

  return (
    <section className="studio-stage" aria-label="Xem trước">
      <div className="stage-bar">
        <Link className="back-link" href={projHref(pid, "videos")}>
          ‹ Video &amp; Lồng tiếng
        </Link>
        <span className="grow" />
        <div className="seg stage-mode" role="group" aria-label="Sân khấu">
          <button type="button" className={view !== "frame" ? "active" : ""} aria-pressed={view !== "frame"} title="Phát bản đã xuất" onClick={() => setView("video")}>
            <Icon name="play" size={13} /> Video
          </button>
          <button
            type="button"
            className={view === "frame" ? "active" : ""}
            aria-pressed={view === "frame"}
            title="Khung hình xem trước: thấy ngay phụ đề/vùng che mới, kéo chuột để khoanh vùng logo hoặc phụ đề gốc"
            onClick={() => {
              setView("frame");
              video.current?.pause();
            }}
          >
            <Icon name="image" size={13} /> Khung hình
          </button>
        </div>
        {srcUrl && (
          <button
            className={`icon-btn cmp-toggle ${view === "compare" ? "on" : ""}`}
            type="button"
            aria-pressed={view === "compare"}
            aria-label="So sánh video gốc và bản đã chỉnh"
            title={view === "compare" ? "Tắt so sánh" : "So sánh: video gốc | bản đã chỉnh, chia đôi màn"}
            onClick={() => setView((v) => (v === "compare" ? "video" : "compare"))}
          >
            <Icon name="compare" size={16} />
          </button>
        )}
        {d?.mp4_file && (
          <a className="btn btn-quiet btn-sm" href={dubFileUrl(d.mp4_file)} download>
            <Icon name="download" size={14} /> MP4
          </a>
        )}
        {d?.srt_file && (
          <a className="btn btn-quiet btn-sm" href={dubFileUrl(d.srt_file)} download>
            <Icon name="cc" size={14} /> SRT
          </a>
        )}
      </div>
      {view === "frame" && (
        <FrameStage
          rel={inputPath}
          burn={sub}
          style={sub ? subStyle : null}
          delogo={delogo}
          subcover={subcover}
          target={target}
          onTarget={setTarget}
          onRegion={(t, v) => (t === "logo" ? setDelogo(v) : setSubcover(v))}
        />
      )}
      <div className={`stage-view ${view === "compare" ? "split" : ""}`} hidden={view === "frame"}>
        {view === "compare" && (
          <div className="cmp-pane" key="src">
            <video ref={srcVideo} className="stage-video" src={srcUrl} muted={cmpAudio !== "src"} playsInline preload="auto" />
            <span className="cmp-tag">Gốc</span>
          </div>
        )}
        <div className="cmp-pane" key="dub">
          {/* Không dùng thanh điều khiển gốc của <video>: timeline bên dưới là thanh phát duy nhất (phát/dừng, thời gian, phím cách).
              Bấm vào khung để phát/dừng; nút góc trên phải mở toàn màn hình. */}
          <video
            ref={video}
            key={stamp}
            className="stage-video is-main"
            preload="metadata"
            src={dubFileUrl(`${jobId}.mp4`) + `?v=${stamp}`}
            onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
          />
          {view === "compare" ? (
            <span className="cmp-tag dub">Đã chỉnh</span>
          ) : (
            <button
              className="icon-btn stage-fs"
              type="button"
              title="Toàn màn hình"
              aria-label="Xem toàn màn hình"
              onClick={() => video.current?.requestFullscreen?.()}
            >
              <Icon name="expand" size={16} />
            </button>
          )}
        </div>
      </div>
      {view === "compare" && <CompareBar master={video} follower={srcVideo} audio={cmpAudio} onAudio={setCmpAudio} reset={stamp} />}
    </section>
  );
}
