"use client";
/** Tay kéo đổi độ rộng thanh bên; lưu vào localStorage (layout đọc lại trước khi vẽ). Bấm đúp để về mặc định. */

/** snapAt: kéo hẹp hơn ngưỡng này thì gọi onSnap(true) (thu thành dải icon); kéo rộng ra lại thì onSnap(false). */
type Props = {
  cssVar: "sb-w" | "rail-w";
  min: number;
  max: number;
  side: "left" | "right";
  label: string;
  snapAt?: number;
  onSnap?: (mini: boolean) => void;
};

export function Resizer({ cssVar, min, max, side, label, snapAt, onSnap }: Props) {
  const root = () => document.documentElement;
  const set = (w: number) => {
    w = Math.round(Math.max(min, Math.min(max, w)));
    root().style.setProperty(`--${cssVar}`, `${w}px`);
    localStorage.setItem(cssVar, String(w));
  };
  const width = (el: HTMLElement) => el.parentElement!.getBoundingClientRect().width;

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const h = e.currentTarget;
        h.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
        const move = (ev: PointerEvent) => {
          const w = side === "right" ? window.innerWidth - ev.clientX : ev.clientX;
          if (snapAt && onSnap) {
            const mini = w < snapAt;
            document.body.classList.toggle("resize-snap", mini);
            onSnap(mini);
            if (mini) return;
          }
          set(w);
        };
        // pointercancel: thao tác cảm ứng bị hệ thống ngắt → vẫn phải gỡ lớp resizing/resize-snap, không để kẹt.
        const end = () => {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", end);
          h.removeEventListener("pointercancel", end);
          document.body.classList.remove("resizing", "resize-snap");
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", end);
        h.addEventListener("pointercancel", end);
      }}
      onDoubleClick={() => {
        root().style.removeProperty(`--${cssVar}`);
        localStorage.removeItem(cssVar);
      }}
      onKeyDown={(e) => {
        const d = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[e.key];
        if (!d) return;
        e.preventDefault();
        const grow = side === "right" ? -d : d;
        const w = width(e.currentTarget);
        if (snapAt && onSnap) {
          // Đang là dải icon: mũi tên "mở rộng" thì mở thanh ra thật (về độ rộng đã nhớ), mũi tên "thu" thì không làm gì.
          if (w < snapAt) {
            if (grow > 0) onSnap(false);
            return;
          }
          // Đang ở độ rộng tối thiểu mà còn thu nữa → chuyển sang dải icon, giống khi kéo chuột.
          if (grow < 0 && w + grow < min) {
            onSnap(true);
            return;
          }
        }
        set(w + grow);
      }}
    />
  );
}
