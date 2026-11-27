"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { PlayerModal } from "@/components/Modal";
import { ProjectTopbar } from "@/components/ProjectTopbar";
import { ProgressBar } from "@/components/TaskCard";
import { useToast } from "@/components/Toasts";
import { EmptyState, Menu, Metric, Seg } from "@/components/ui";
import { AddVideoModal } from "@/components/video/AddVideoModal";
import { DubConfigModal } from "@/components/video/DubConfigModal";
import { WorkItem, buildWorkItems } from "@/components/video/items";
import { DeleteVideoModal, DelogoModal, MoveVideoModal } from "@/components/video/SmallModals";
import { dubFileUrl, postJSON } from "@/lib/api";
import { fmtDur, fmtHours, fmtSize, projHref } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";

type Filter = "all" | "new" | "partial" | "dubbed";
type Dialog =
  | { kind: "add" }
  | { kind: "dub" | "delogo" | "move" | "delete"; v: WorkItem }
  | { kind: "play"; src: string; title: string }
  | null;

function VideoRow({ v, open }: { v: WorkItem; open: (d: Dialog) => void }) {
  const toast = useToast();
  const { task, projects, startTask, stopTask, reload } = useStudio();
  const pid = useProjectId();
  const d = v.dub;
  const j = v.job;
  const running = Boolean(task?.running && task.target && (task.target === v.rel_path || task.target === (d?.job_id || j?.job_id)));
  const qi = running ? -1 : (task?.queue || []).findIndex((q) => q.target && (q.target === v.rel_path || q.target === (d?.job_id || j?.job_id)));

  const meta = [v.source === "bilibili" ? "Bilibili / YouTube" : "Douyin", v.resolution, fmtSize(v.size_mb), v.uploader].filter(Boolean);
  const playDub = () => open({ kind: "play", src: dubFileUrl(d!.mp4_file), title: `Bản Việt · ${v.title}` });
  const playOrig = () => open({ kind: "play", src: v.video_src, title: v.title });

  async function claim() {
    const r = await postJSON("/api/source/assign", { rel_path: v.rel_path, project_id: pid });
    if (!r.ok) return toast(r.error || "Không gán được video", "error");
    toast("Đã thêm video vào dự án", "success");
    reload();
  }
  async function clean() {
    if (!confirm("Xóa cache của bản lồng tiếng này?\n\nVideo đã xuất vẫn giữ nguyên. Lần xuất lại sau sẽ phải tạo lại giọng đọc và mã hóa lại toàn bộ.")) return;
    const r = await postJSON("/api/dub/clean", { job_id: d!.job_id });
    toast(r.ok ? "Đã xóa cache" : r.error || "Không xóa được cache", r.ok ? "success" : "error");
    reload();
  }

  // Nút chính theo trạng thái: Thêm vào dự án > Tiếp tục > Xem bản Việt > Lồng tiếng
  const primary = !v.project_id ? (
    <button className="btn btn-primary" type="button" onClick={claim}>
      <Icon name="plus" size={15} /> Thêm vào dự án này
    </button>
  ) : j ? (
    <button className="btn btn-primary" type="button" onClick={() => startTask("/api/dub/start", { rel_path: v.rel_path, ...j.params }, "Đang chạy tiếp từ chỗ đang dở")}>
      <Icon name="play" size={15} /> Tiếp tục
    </button>
  ) : d ? (
    <button className="btn btn-success" type="button" onClick={playDub}>
      <Icon name="play" size={15} /> Xem bản Việt
    </button>
  ) : (
    <button className="btn btn-primary" type="button" onClick={() => open({ kind: "dub", v })}>
      <Icon name="mic" size={15} /> Lồng tiếng
    </button>
  );

  return (
    <article className={`vrow ${running ? "is-running" : ""}`}>
      <button className="vrow-thumb" type="button" onClick={d ? playDub : playOrig} aria-label="Phát video">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/thumb?rel=${encodeURIComponent(v.rel_path)}&v=${v.mtime}`} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
        <span className="thumb-play">
          <Icon name="play" size={20} />
        </span>
        {v.duration_sec ? <span className="thumb-dur">{fmtDur(v.duration_sec)}</span> : null}
      </button>
      <div className="vrow-main">
        <h3 className="vrow-title" title={v.title}>
          {v.title}
        </h3>
        <div className="vrow-meta">{meta.join(" · ")}</div>
        <div className="vrow-chips when-idle">
          {!v.project_id && <span className="badge amber">Chưa gán dự án</span>}
          {d && (
            <span className="badge green">
              <Icon name="check" size={13} /> Đã lồng tiếng · {(d.segment_count || 0).toLocaleString("vi")} câu
            </span>
          )}
          {j && (
            <span className={`badge ${j.status === "error" ? "red" : "amber"}`}>
              {j.status === "error" ? "Lỗi" : "Đang dở"} ở {Math.round(j.pct)}%
            </span>
          )}
          {!d && !j && <span className="badge gray">Chưa lồng tiếng</span>}
          {d?.untranslated ? <span className="badge amber">{d.untranslated} câu chưa dịch</span> : null}
          {(v.delogo !== "none" || (d?.delogo && d.delogo !== "none")) && <span className="badge blue">Đã xóa logo</span>}
          {qi >= 0 && (
            <span className="badge gray">
              <Icon name="clock" size={13} /> Trong hàng đợi · thứ {qi + 1}
            </span>
          )}
        </div>
        {j?.error && (
          <div className="vrow-err when-idle">
            <Icon name="alert" size={14} /> {j.error}
          </div>
        )}
        {running && task && (
          <div className="js-vid-prog">
            <ProgressBar task={task} />
          </div>
        )}
      </div>
      <div className="vrow-actions">
        <button className="btn btn-danger when-running" type="button" onClick={stopTask}>
          <Icon name="stop" size={15} /> Dừng
        </button>
        <span className="when-idle vrow-btns">
          {j && d && (
            <button className="btn btn-light" type="button" onClick={playDub}>
              <Icon name="play" size={15} /> Bản Việt
            </button>
          )}
          {d && (
            <Link className="btn btn-light" href={projHref(pid, "video", `&job=${encodeURIComponent(d.job_id)}`)}>
              <Icon name="edit" size={15} /> Chỉnh sửa
            </Link>
          )}
          {primary}
        </span>
        <Menu>
          {d && (
            <a href={dubFileUrl(d.mp4_file)} download>
              <Icon name="download" size={15} /> Tải MP4 bản Việt
            </a>
          )}
          {d?.srt_file && (
            <a href={dubFileUrl(d.srt_file)} download>
              <Icon name="cc" size={15} /> Tải phụ đề SRT
            </a>
          )}
          {(d || j) && (
            <button type="button" onClick={() => open({ kind: "dub", v })}>
              <Icon name="mic" size={15} /> {j ? "Tùy chọn / làm lại từ đầu" : "Lồng tiếng lại"}
            </button>
          )}
          <button type="button" onClick={playOrig}>
            <Icon name="film" size={15} /> Xem video gốc
          </button>
          {(projects.length > 1 || !v.project_id) && (
            <button type="button" onClick={() => open({ kind: "move", v })}>
              <Icon name="folder" size={15} /> Chuyển sang dự án khác
            </button>
          )}
          {v.source === "bilibili" && (
            <button type="button" onClick={() => open({ kind: "delogo", v })}>
              <Icon name="sparkles" size={15} /> Xóa logo video gốc
            </button>
          )}
          {d?.cache_mb ? (
            <button type="button" onClick={clean}>
              <Icon name="disk" size={15} /> Xóa cache ({fmtSize(d.cache_mb)})
            </button>
          ) : null}
          <hr />
          <button type="button" className="danger" onClick={() => open({ kind: "delete", v })}>
            <Icon name="trash" size={15} /> Xóa video
          </button>
        </Menu>
      </div>
    </article>
  );
}

export default function VideosPage() {
  const pid = useProjectId();
  const { sources, dubbed, bili, system, task } = useStudio();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const items = buildWorkItems(sources, dubbed, bili, pid);
  const count = { all: items.length, new: 0, partial: 0, dubbed: 0 };
  items.forEach((v) => count[v.status]++);
  const totalSec = items.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
  const totalMb = items.reduce((a, v) => a + Number(v.size_mb || 0), 0);
  const needle = q.trim().toLowerCase();
  const shown = items.filter(
    (v) => (filter === "all" || v.status === filter) && (!needle || v.title.toLowerCase().includes(needle) || v.name.toLowerCase().includes(needle))
  );
  const downloading = task?.running && task.task_type === "bilibili_download";

  return (
    <>
      <ProjectTopbar title="Video & Lồng tiếng" sub="Tải video, dịch theo ngữ cảnh dự án và lồng tiếng Việt" />
      <main className="content">
        <div className="metrics">
          <Metric icon="film" label="Video nguồn" value={items.length} sub={totalSec ? `Tổng ${fmtHours(totalSec)}` : ""} tone="blue" />
          <Metric icon="mic" label="Đã lồng tiếng" value={count.dubbed} sub={count.partial ? `${count.partial} video đang dở` : ""} tone="green" />
          <Metric icon="disk" label="Dung lượng video" value={fmtSize(totalMb)} sub={`Ổ còn trống ${system.free_gb || 0} GB`} tone="violet" />
        </div>
        <div className="toolbar ws-toolbar">
          <Seg<Filter>
            value={filter}
            onChange={setFilter}
            items={[
              { v: "all", label: "Tất cả ", count: count.all },
              { v: "new", label: "Chưa làm ", count: count.new },
              { v: "partial", label: "Đang dở ", count: count.partial },
              { v: "dubbed", label: "Đã lồng tiếng ", count: count.dubbed },
            ]}
          />
          <input className="input" type="search" placeholder="Tìm video theo tên..." aria-label="Tìm video" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" type="button" onClick={() => setDialog({ kind: "add" })}>
            <Icon name="plus" size={16} /> Thêm video
          </button>
        </div>
        {downloading && task && (
          <div className="inline-task">
            <b>
              <Icon name="download" size={16} /> Tải video Bilibili / YouTube
            </b>
            <ProgressBar task={task} />
          </div>
        )}
        <div className="vlist">
          {!items.length ? (
            <EmptyState icon="film" title="Chưa có video nào" desc="Dán link Bilibili / YouTube để tải video đầu tiên, hoặc tải từ Kho Douyin.">
              <button className="btn btn-primary" type="button" onClick={() => setDialog({ kind: "add" })}>
                <Icon name="plus" size={16} /> Thêm video
              </button>
            </EmptyState>
          ) : !shown.length ? (
            <EmptyState icon="search" title="Không có video phù hợp" desc="Thử đổi bộ lọc hoặc từ khóa tìm kiếm." />
          ) : (
            shown.map((v) => <VideoRow key={v.rel_path} v={v} open={setDialog} />)
          )}
        </div>
      </main>

      {dialog?.kind === "add" && <AddVideoModal projectId={pid} onClose={close} />}
      {dialog?.kind === "dub" && <DubConfigModal v={dialog.v} projectId={pid} onClose={close} />}
      {dialog?.kind === "delogo" && <DelogoModal v={dialog.v} onClose={close} />}
      {dialog?.kind === "move" && <MoveVideoModal v={dialog.v} onClose={close} />}
      {dialog?.kind === "delete" && <DeleteVideoModal v={dialog.v} onClose={close} />}
      {dialog?.kind === "play" && <PlayerModal src={dialog.src} title={dialog.title} onClose={close} />}
    </>
  );
}
