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
        h.addEventListener("pointermove", move);
        h.addEventListener(
          "pointerup",
          () => {
            h.removeEventListener("pointermove", move);
            document.body.classList.remove("resizing", "resize-snap");
          },
          { once: true }
        );
      }}
      onDoubleClick={() => {
        root().style.removeProperty(`--${cssVar}`);
        localStorage.removeItem(cssVar);
      }}
      onKeyDown={(e) => {
        const d = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[e.key];
        if (d) set(width(e.currentTarget) + (side === "right" ? -d : d));
      }}
    />
  );
}
