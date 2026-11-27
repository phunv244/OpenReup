"use client";
import { useLayoutEffect, useRef } from "react";
import { useStudio } from "@/lib/studio";

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
