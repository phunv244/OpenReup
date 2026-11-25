"use client";
/**
 * Khoanh vùng logo trên khung hình giây đầu của video.
 * rel: đường dẫn file trong downloads; initial: "x,y,w,h" (pixel gốc) hoặc "".
 * onChange nhận "x,y,w,h" theo pixel gốc, hoặc "" khi chưa chọn.
 */
import { useEffect, useRef, useState } from "react";
import { isRegion } from "@/lib/format";

type Rect = { x: number; y: number; w: number; h: number }; // tỉ lệ 0..1 so với khung hình

export function RegionPicker({ rel, initial = "", onChange }: { rel: string; initial?: string; onChange: (v: string) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const [error, setError] = useState(false);
  const [sel, setSel] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  // ffmpeg delogo báo lỗi nếu vùng chạm mép: giữ x,y ≥ 1 và chừa 1px ở mép phải/dưới.
  const toPx = (r: Rect, W: number, H: number) => {
    const x = Math.min(Math.max(1, Math.round(r.x * W)), W - 6);
    const y = Math.min(Math.max(1, Math.round(r.y * H)), H - 6);
    const w = Math.max(4, Math.min(Math.round(r.w * W), W - 1 - x));
    const h = Math.max(4, Math.min(Math.round(r.h * H), H - 1 - y));
    return { x, y, w, h };
  };
  const px = sel && size ? toPx(sel, size.W, size.H) : null;
  const value = px ? `${px.x},${px.y},${px.w},${px.h}` : "";
  useEffect(() => changed.current(value), [value]);

  const pt = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  return (
    <div className="rp">
      <div
        className="rp-stage"
        ref={stage}
        onPointerDown={(e) => {
          if (!size || e.button > 0) return;
          e.preventDefault();
          start.current = pt(e);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const p = pt(e);
          setSel({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
        }}
        onPointerUp={() => {
          if (!start.current) return;
          start.current = null;
          // Bấm trơn không kéo thì không tính là vùng.
          setSel((r) => (r && size && (r.w * size.W < 4 || r.h * size.H < 4) ? null : r));
        }}
        onPointerCancel={() => (start.current = null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={img}
          alt="Khung hình giây đầu của video"
          draggable={false}
          src={`/api/frame?rel=${encodeURIComponent(rel)}`}
          onLoad={(e) => {
            const W = e.currentTarget.naturalWidth;
            const H = e.currentTarget.naturalHeight;
            setSize({ W, H });
            if (isRegion(initial)) {
              const [x, y, w, h] = initial.split(",").map(Number);
              setSel({ x: x / W, y: y / H, w: w / W, h: h / H });
            }
          }}
          onError={() => setError(true)}
        />
        {sel && (
          <div className="rp-box" style={{ left: `${sel.x * 100}%`, top: `${sel.y * 100}%`, width: `${sel.w * 100}%`, height: `${sel.h * 100}%` }} />
        )}
        {!size && (
          <div className="rp-loading">
            {error ? "Không lấy được khung hình — cần cài ffmpeg và file video gốc phải còn trên máy." : "Đang lấy khung hình…"}
          </div>
        )}
      </div>
      <div className="rp-bar">
        <span className="rp-info muted">
          {px && size
            ? `Vùng ${px.w}×${px.h}px tại (${px.x}, ${px.y}) · video ${size.W}×${size.H}`
            : "Kéo chuột trên khung hình để khoanh vùng."}
        </span>
        {sel && (
          <button className="btn btn-quiet btn-sm" type="button" onClick={() => setSel(null)}>
            Chọn lại
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Công tắc bật/tắt một vùng trên khung hình (xóa logo, che phụ đề gốc): mặc định tắt.
 * Bật lên thì bắt buộc khoanh vùng. onChange nhận giá trị gửi server: "none" khi tắt, "x,y,w,h" khi đã khoanh,
 * "" khi đã bật nhưng chưa kéo vùng nào (bên gọi phải chặn lại).
 */
export function RegionToggle({ label, hint, rel, initial, onChange }: {
  label: string;
  hint?: React.ReactNode;
  rel: string;
  initial?: string;
  onChange: (v: string) => void;
}) {
  // Bản cũ có thể đã lưu vị trí góc ("top-right"...): vẫn coi là đang bật, nhưng phải khoanh vùng lại.
  const [on, setOn] = useState(Boolean(initial && initial !== "none"));
  const [region, setRegion] = useState(isRegion(initial) ? String(initial) : "");
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => changed.current(on ? region : "none"), [on, region]);
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> {label}
      </label>
      {hint && <div className="help">{hint}</div>}
      {on && <RegionPicker rel={rel} initial={isRegion(initial) ? initial : ""} onChange={setRegion} />}
    </div>
  );
}
