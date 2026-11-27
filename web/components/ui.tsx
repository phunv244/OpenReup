"use client";
/** Các mảnh giao diện nhỏ dùng chung (cùng class CSS với giao diện cũ). */
import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

export function EmptyState({ icon, title, desc, children }: { icon: string; title: string; desc: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ico">
        <Icon name={icon} size={26} />
      </div>
      <h4>{title}</h4>
      <p>{desc}</p>
      {children}
    </div>
  );
}

export function Callout({ tone, icon, children }: { tone: string; icon: string; children: React.ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <Icon name={icon} size={17} />
      <div>{children}</div>
    </div>
  );
}

export function Options({ list }: { list: [string, string][] }) {
  return (
    <>
      {list.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </>
  );
}

/** Nhóm nút chọn 1 (class .seg). */
export function Seg<T extends string>({
  value, onChange, items, label,
}: { value: T; onChange: (v: T) => void; items: { v: T; label: React.ReactNode; count?: number; disabled?: boolean; title?: string }[]; label?: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.v}
          type="button"
          className={it.v === value ? "active" : ""}
          disabled={it.disabled}
          title={it.title}
          aria-label={it.title}
          onClick={() => onChange(it.v)}
        >
          {it.label}
          {it.count != null && <span className="cnt">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Menu "⋯": đóng khi bấm ra ngoài hoặc chọn một mục. */
export function Menu({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const d = ref.current;
      if (d?.open && !d.contains(e.target as Node)) d.removeAttribute("open");
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className="icon-btn" title="Thao tác khác" aria-label="Thao tác khác">
        <Icon name="more" />
      </summary>
      <div className="menu-pop" onClick={() => ref.current?.removeAttribute("open")}>
        {children}
      </div>
    </details>
  );
}

export function copyText(text: string, toast: (m: string, t?: "success" | "error") => void) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast("Đã sao chép", "success"))
    .catch(() => toast("Không sao chép được, hãy copy thủ công", "error"));
}
