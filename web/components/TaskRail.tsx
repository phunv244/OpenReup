"use client";
import Link from "next/link";
import { baseName, exitTone, fmtClock, taskName } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { LogConsole } from "./LogConsole";
import { Resizer } from "./Resizer";
import { TaskCard } from "./TaskCard";

/** Cột phải (bật/tắt từ nút trên thanh tiêu đề): tác vụ đang chạy, hàng đợi, vừa xong; nhật ký thu gọn sẵn. */
export function TaskRail({ onClose }: { onClose: () => void }) {
  const { task, unqueue } = useStudio();
  const queue = task?.queue || [];
  const history = task?.history || [];
  return (
    <aside className="rail" aria-label="Tiến trình và hàng đợi">
      <Resizer cssVar="rail-w" min={260} max={640} side="right" label="Kéo để đổi độ rộng cột bên phải" />
      <section className="rail-sec">
        <h4>
          Đang chạy
          <button className="icon-btn rail-close" type="button" onClick={onClose} aria-label="Đóng cột tiến trình" title="Đóng">
            <Icon name="x" size={14} />
          </button>
        </h4>
        <TaskCard variant="rail" />
      </section>
      <section className="rail-sec">
        <h4>
          Hàng đợi <span className="badge gray">{queue.length}</span>
        </h4>
        <ul className="rail-list">
          {queue.length ? (
            queue.map((it, i) => (
              <li className="rail-item" key={it.id}>
                <span className="rail-num">{i + 1}</span>
                <div className="rail-main">
                  <b>{taskName(it.type)}</b>
                  {it.target && <span className="muted" title={it.target}>{baseName(it.target)}</span>}
                </div>
                <button className="icon-btn" type="button" onClick={() => unqueue(it.id)} aria-label="Bỏ khỏi hàng đợi" title="Bỏ khỏi hàng đợi">
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))
          ) : (
            <li className="rail-empty muted">Trống. Bấm lồng tiếng, tải… khi đang bận sẽ tự xếp vào đây.</li>
          )}
        </ul>
      </section>
      <section className="rail-sec">
        <h4>Vừa xong</h4>
        <ul className="rail-list">
          {history.length ? (
            history.slice(0, 8).map((it) => {
              const tone = exitTone(it.exit_code);
              return (
                <li className={`rail-item ${tone === "stopped" ? "" : tone}`} key={`${it.ended_at}-${it.type}`}>
                  <span className="dot" />
                  <div className="rail-main">
                    <b>{taskName(it.type)}</b>
                    {it.target && <span className="muted" title={it.target}>{baseName(it.target)}</span>}
                  </div>
                  <span className="muted rail-time">{fmtClock(it.ended_at)}</span>
                </li>
              );
            })
          ) : (
            <li className="rail-empty muted">Chưa có tác vụ nào xong.</li>
          )}
        </ul>
      </section>
      <details className="rail-sec rail-log">
        <summary>
          <h4>
            <Icon name="chevron" size={13} /> Nhật ký{" "}
            <Link className="rail-more" href="/logs/">
              Xem đầy đủ
            </Link>
          </h4>
        </summary>
        <LogConsole />
      </details>
    </aside>
  );
}
