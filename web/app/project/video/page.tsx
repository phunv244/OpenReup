"use client";
/**
 * Chi tiết một bản lồng tiếng — bố cục studio (kiểu CapCut): video lớn ở giữa, panel chỉnh sửa bên phải
 * (3 tab: lời thoại, giọng đọc, hình & phụ đề), timeline cắt/ghép trải hết chiều ngang ở dưới,
 * một nút "Lưu & chạy lại" chung cho tất cả. Cả màn vừa khít chiều cao cửa sổ, không có khoảng trống thừa.
 * Server tự chọn mức làm lại nhỏ nhất (chỉ hình / chỉ tiếng) theo những gì thực sự đổi.
 * Trạng thái và logic lưu: components/video/studio/useDubDetail.ts.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { EmptyState } from "@/components/ui";
import { DubScript } from "@/components/video/DubScript";
import { LogoToggle, RegionTarget, activeTarget } from "@/components/video/FrameStage";
import { SubtitleStudio } from "@/components/video/SubtitleStudio";
import { TimelineEditor } from "@/components/video/TimelineEditor";
import { DetailBar } from "@/components/video/studio/DetailBar";
import { Stage, StageView } from "@/components/video/studio/Stage";
import { useDubDetail } from "@/components/video/studio/useDubDetail";
import { displayTitle } from "@/components/video/items";
import { VoicePane } from "@/components/video/studio/VoicePane";
import { fmtDur, fmtSize, projHref } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";

type Tab = "script" | "voice" | "video";

function Detail() {
  const jobId = useSearchParams().get("job") || "";
  const pid = useProjectId();
  const { projects, bili } = useStudio();
  const s = useDubDetail(jobId);
  const [tab, setTabRaw] = useState<Tab>("script");
  const [view, setView] = useState<StageView>("video");
  const [target, setTarget] = useState<RegionTarget | null>(null);
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  // Sang tab "Hình & phụ đề" thì sân khấu lớn chuyển sang khung hình xem trước; rời tab thì về video.
  const setTab = (t: Tab) => {
    setTabRaw(t);
    setView((v) => (t === "video" ? "frame" : v === "frame" ? "video" : v));
    if (t === "video") video.current?.pause();
  };
  const pick = (t: RegionTarget) => {
    setTarget(t);
    setView("frame");
    video.current?.pause();
  };

  const { info, loadError, d } = s;
  if (!jobId) return <main className="content"><p className="muted">Thiếu mã bản lồng tiếng.</p></main>;
  if (!info && loadError)
    return (
      <main className="content">
        <EmptyState icon="alert" title="Không mở được bản lồng tiếng" desc={loadError}>
          <Link className="btn btn-light" href={projHref(pid, "videos")}>Về danh sách video</Link>
        </EmptyState>
      </main>
    );
  if (!info) return <main className="content"><p className="muted">Đang tải...</p></main>;

  const proj = projects.find((p) => p.id === (info.project_id || pid));
  const meta = [
    info.resolution,
    d?.duration_sec ? fmtDur(d.duration_sec) : "",
    d?.size_mb ? fmtSize(d.size_mb) : "",
    info.speed ? `${info.speed}x` : "",
    `${info.total.toLocaleString("vi")} câu`,
    d?.agy_model || "",
  ].filter(Boolean);
  const tabs = [
    ["script", "edit", "Lời thoại", s.editCount > 0 || s.structural],
    ["voice", "mic", "Giọng đọc", s.settingsAudioDirty],
    ["video", "cc", "Hình & phụ đề", s.settingsVideoDirty],
  ] as const;

  return (
    <>
      <Topbar title={displayTitle(info.title, bili)} meta={meta.join(" · ")} />
      <main className="studio">
        <Stage
          s={s}
          jobId={jobId}
          pid={pid}
          view={view}
          setView={setView}
          video={video}
          target={activeTarget(target, s.delogo, s.subcover)}
          setTarget={setTarget}
        />

        <aside className="studio-panel" aria-label="Chỉnh sửa">
          <div className="seg studio-tabs" role="tablist" aria-label="Phần cần sửa">
            {tabs.map(([k, icon, label, dirty]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                <Icon name={icon} size={15} /> {label}
                {dirty ? <span className="tab-dot" title="Có thay đổi chưa lưu" /> : null}
              </button>
            ))}
          </div>

          <div className="panel-pane script-pane" hidden={tab !== "script"}>
            <div className="sel-host" ref={setDetailHost} />
            <DubScript
              jobId={jobId}
              video={video}
              speakers={s.speakers}
              edits={s.edits}
              setEdits={s.setEdits}
              spk={s.spk}
              setSpk={s.setSpk}
              reloadKey={s.tableKey}
              resetKey={s.stamp}
            />
          </div>

          <div className="panel-pane" hidden={tab !== "voice"}>
            <VoicePane s={s} proj={proj} />
          </div>

          <div className="panel-pane" hidden={tab !== "video"}>
            <LogoToggle value={s.delogo} saved={info.delogo} onChange={s.setDelogo} onPick={() => pick("logo")} />
            <SubtitleStudio
              burn={s.sub}
              onBurn={s.setSub}
              subcover={s.subcover}
              onSubcover={s.setSubcover}
              onPick={() => pick("sub")}
              style={s.subStyle}
              onStyle={s.setSubStyle}
            />
          </div>
        </aside>

        <section className="studio-timeline" aria-label="Timeline">
          <TimelineEditor
            key={s.stamp}
            jobId={jobId}
            video={video}
            speakers={s.speakers}
            edits={s.edits}
            setEdits={s.setEdits}
            spk={s.spk}
            setSpk={s.setSpk}
            onStructuralChange={s.onStructuralChange}
            detailHost={detailHost}
            onSelect={() => setTab("script")}
            spaceOff={view === "frame"}
          />
        </section>
      </main>

      <DetailBar s={s} />
    </>
  );
}

export default function VideoDetailPage() {
  return (
    <Suspense fallback={null}>
      <Detail />
    </Suspense>
  );
}
