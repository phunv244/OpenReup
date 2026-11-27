"use client";
import Link from "next/link";
import { TaskState } from "@/lib/api";
import { DUB_STAGES, exitTone, fmtEta, taskName } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";

export function ProgressBar({ task, steps = true }: { task: TaskState; steps?: boolean }) {
  const p = task.progress || { pct: 0, label: "", eta: null, stage: 0 };
  const pct = Math.max(0, Math.min(100, Number(p.pct || 0)));
  const isDub = task.task_type === "dub_video" || task.task_type === "dub_rerender";
  const eta = fmtEta(p.eta);
  return (
    <>
      {steps && isDub && p.stage > 0 && (
        <ol className="stages">
          {DUB_STAGES.map((s, i) => (
            <li key={s} className={i + 1 < p.stage ? "done" : i + 1 === p.stage ? "active" : ""}>
              {s}
            </li>
          ))}
        </ol>
      )}
      <div className={`progress ${pct < 0.5 ? "indet" : ""}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="prog-meta">
        <span className="prog-label">{p.label || "Đang xử lý..."}</span>
        <span className="prog-pct">
          {pct >= 0.5 ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : ""}
          {eta ? ` · ${eta}` : ""}
        </span>
      </div>
    </>
  );
}

/** Thẻ tiến trình: ở chân sidebar (gọn), cột phải và đầu trang Nhật ký (đủ các bước). */
/** Dưới ngưỡng này mới cảnh báo ổ đầy; còn dư thì không hiện số dung lượng. */
const LOW_DISK_GB = 10;

export function TaskCard({ variant }: { variant: "sidebar" | "rail" | "page" }) {
  const { task, stopTask, system } = useStudio();
  if (!task) return null;
  const lowDisk = !task.running && system.total_gb > 0 && system.free_gb < LOW_DISK_GB;
  const wrap = (node: React.ReactNode) => (
    <div className="js-task" data-variant={variant}>
      {node}
      {lowDisk && (
        <div className="task-card err disk-warn" role="status">
          <div className="task-head">
            <Icon name="disk" size={14} />
            <b>Ổ cứng sắp đầy · còn {system.free_gb} GB</b>
          </div>
          <div className="task-result">Xóa cache hoặc video cũ trước khi lồng tiếng tiếp.</div>
        </div>
      )}
    </div>
  );

  if (task.running) {
    return wrap(
      <div className="task-card busy">
        <div className="task-head">
          <span className="dot" />
          <b>{taskName(task.task_type)}</b>
        </div>
        <ProgressBar task={task} steps={variant !== "sidebar"} />
        <div className="task-actions">
          {variant === "sidebar" && (
            <Link className="btn btn-quiet btn-sm" href="/logs/">
              Nhật ký
            </Link>
          )}
          <button className="btn btn-danger btn-sm" type="button" onClick={stopTask}>
            <Icon name="stop" size={14} /> Dừng
          </button>
        </div>
      </div>
    );
  }
  if (task.last_type) {
    const tone = exitTone(task.exit_code);
    return wrap(
      <div className={`task-card ${tone === "stopped" ? "" : tone}`}>
        <div className="task-head">
          <span className="dot" />
          <b>{taskName(task.last_type)}</b>
        </div>
        <div className="task-result">
          {tone === "ok" ? "Đã hoàn tất" : tone === "stopped" ? "Đã dừng — tiến độ được lưu" : <>Gặp lỗi — <Link href="/logs/">xem nhật ký</Link></>}
        </div>
      </div>
    );
  }
  return wrap(
    <div className="task-card">
      <div className="task-head">
        <span className="dot" />
        <span>Sẵn sàng</span>
      </div>
    </div>
  );
}
