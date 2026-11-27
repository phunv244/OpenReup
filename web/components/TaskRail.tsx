"use client";
import { baseName, exitTone, fmtClock, taskName } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { LogConsole } from "./LogConsole";
import { Resizer } from "./Resizer";
import { TaskCard } from "./TaskCard";
import { useToast } from "./Toasts";
import { copyText } from "./ui";

/** Cột phải (bật/tắt từ nút trên thanh tiêu đề): tác vụ đang chạy, hàng đợi, vừa xong; nhật ký thu gọn sẵn (có nút Sao chép). */
export function TaskRail({ onClose }: { onClose: () => void }) {
  const { task, unqueue } = useStudio();
  const toast = useToast();
  const logs = task?.logs || [];
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
            <Icon name="chevron" size={13} /> Nhật ký
            {logs.length > 0 && (
              <button
                className="btn btn-quiet btn-sm rail-more"
                type="button"
                title="Sao chép toàn bộ nhật ký đang hiện"
                onClick={(e) => {
                  e.preventDefault(); // không thu/mở mục nhật ký khi bấm Sao chép
                  copyText(logs.join("\n"), toast);
                }}
              >
                <Icon name="copy" size={13} /> Sao chép
              </button>
            )}
          </h4>
        </summary>
        <LogConsole />
        {logs.length > 0 && <div className="rail-log-foot muted">500 dòng gần nhất · đầy đủ ở data/last_task.log</div>}
      </details>
    </aside>
  );
}
