"use client";
import { useLayoutEffect, useRef } from "react";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { TaskCard } from "./TaskCard";
import { useToast } from "./Toasts";
import { copyText } from "./ui";

/** Nhật ký của tác vụ gần nhất; tự cuộn xuống cuối nếu người dùng đang ở cuối. */
export function LogConsole({ className = "" }: { className?: string }) {
  const { task } = useStudio();
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const text = (task?.logs || []).join("\n") || "Chưa có nhật ký. Khi bạn bấm tải, quét hoặc lồng tiếng, tiến trình sẽ hiện ở đây.";

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className={`console ${className}`}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      }}
    >
      {text}
    </pre>
  );
}

/** Nội dung trang Nhật ký (dùng ở cả trang chung và trang trong dự án). */
export function LogsBody() {
  const { task } = useStudio();
  const toast = useToast();
  return (
    <main className="content">
      <TaskCard variant="page" />
      <section className="card">
        <header className="card-head">
          <h3>Nhật ký chi tiết</h3>
          <button className="btn btn-light btn-sm" type="button" onClick={() => copyText((task?.logs || []).join("\n"), toast)}>
            <Icon name="copy" size={14} /> Sao chép
          </button>
        </header>
        <LogConsole />
        <div className="card-foot muted">
          Hiện 500 dòng gần nhất. Toàn bộ nhật ký của lần chạy gần nhất nằm ở <code>data/last_task.log</code>.
        </div>
      </section>
    </main>
  );
}
