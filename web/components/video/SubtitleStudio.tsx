"use client";
/**
 * Phụ đề Việt trên MỘT khung hình duy nhất (giống bộ khoanh vùng logo): ảnh do server vẽ bằng đúng bộ lọc lúc xuất,
 * kéo chuột để khoanh vùng chữ Trung — vùng đó được làm mờ và cũng là khung hiện phụ đề Việt. Bên dưới là kiểu chữ.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SubStyle } from "@/lib/api";
import { useStudio } from "@/lib/studio";
import { isRegionValue, startingStyle } from "@/lib/subtitle";
import { Icon } from "../Icon";

type Rect = { x: number; y: number; w: number; h: number }; // tỉ lệ 0..1

// Kiểu dựng sẵn: chỉ đổi màu / nền / viền, giữ nguyên font và cỡ chữ người dùng đã chọn.
const PRESETS: { name: string; style: Partial<SubStyle> | null }[] = [
  { name: "Mặc định", style: null },
  { name: "Viền đen", style: { color: "#FFFFFF", bg_opacity: 0, outline: "#000000", outline_width: 2.5 } },
  { name: "Vàng điện ảnh", style: { color: "#FFE45C", bg_opacity: 0, outline: "#000000", outline_width: 2.5 } },
  { name: "Nền mờ", style: { color: "#FFFFFF", bg: "#000000", bg_opacity: 55, outline_width: 0 } },
  { name: "Neon", style: { color: "#00F0FF", bg_opacity: 0, outline: "#0A1A4A", outline_width: 3 } },
];

const sameStyle = (a: SubStyle | null, p: Partial<SubStyle> | null) =>
  p === null ? a === null : !!a && (Object.keys(p) as (keyof SubStyle)[]).every((k) => a[k] === p[k]);

function Swatch({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children?: React.ReactNode }) {
  return (
    <div className="sw-card">
      <div className="sw-head">
        <input type="color" value={value} aria-label={label} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function Mini({ value, min, max, step, unit, label, onChange }: { value: number; min: number; max: number; step: number; unit: string; label: string; onChange: (v: number) => void }) {
  return (
    <div className="range-input">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>
        {value}
        {unit}
      </output>
    </div>
  );
}

type Props = {
  rel: string;
  burn: boolean;
  onBurn: (v: boolean) => void;
  /** "none" = không che; "" = đã bật che nhưng chưa khoanh (bên gọi phải chặn); "x,y,w,h" = vùng đã khoanh */
  subcover: string;
  initialSubcover?: string;
  onSubcover: (v: string) => void;
  style: SubStyle | null;
  onStyle: (s: SubStyle | null) => void;
};

export function SubtitleStudio({ rel, burn, onBurn, subcover, initialSubcover, onSubcover, style, onStyle }: Props) {
  const { fonts, systemFonts } = useStudio();
  const coverOn = subcover !== "none";
  const region = isRegionValue(subcover) ? subcover : "none";

  /* ---- ảnh xem trước do server vẽ ---- */
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const key = JSON.stringify([rel, region, burn, style]);
  const show = burn || coverOn;

  useEffect(() => {
    if (!rel || !show) return;
    const ctl = new AbortController();
    setLoading(true);
    // Chờ 450 ms sau lần chỉnh cuối rồi mới vẽ: kéo thanh trượt không dồn hàng chục yêu cầu.
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/sub-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rel_path: rel, subcover: region, style, burn }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Lỗi ${res.status}`);
        const blob = await res.blob();
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setError("");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      }
      setLoading(false);
    }, 450);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => setUrl((old) => (old && URL.revokeObjectURL(old), "")), []);

  /* ---- kéo chuột khoanh vùng (giống bộ khoanh vùng logo) ---- */
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const seeded = useRef(false);

  // Nạp vùng đã lưu (một lần, khi đã biết kích thước ảnh)
  useEffect(() => {
    if (seeded.current || !size) return;
    seeded.current = true;
    if (isRegionValue(initialSubcover || "")) {
      const [x, y, w, h] = (initialSubcover as string).split(",").map(Number);
      setSel({ x: x / size.W, y: y / size.H, w: w / size.W, h: h / size.H });
    }
  }, [size, initialSubcover]);
  // Tắt "Che phụ đề gốc" thì bỏ khung
  useEffect(() => {
    if (!coverOn) setSel(null);
  }, [coverOn]);

  // ffmpeg báo lỗi nếu vùng chạm mép: giữ x,y ≥ 1 và chừa 1px ở mép phải/dưới.
  const toPx = (r: Rect, W: number, H: number) => {
    const x = Math.min(Math.max(1, Math.round(r.x * W)), W - 6);
    const y = Math.min(Math.max(1, Math.round(r.y * H)), H - 6);
    return { x, y, w: Math.max(4, Math.min(Math.round(r.w * W), W - 1 - x)), h: Math.max(4, Math.min(Math.round(r.h * H), H - 1 - y)) };
  };
  const px = sel && size ? toPx(sel, size.W, size.H) : null;
  const pt = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const commit = (r: Rect | null) => {
    setSel(r);
    onSubcover(r && size ? Object.values(toPx(r, size.W, size.H)).join(",") : "");
  };

  /* ---- kiểu chữ ---- */
  // Chưa tùy chỉnh: ô điều khiển hiện đúng giá trị của kiểu mặc định đang áp dụng (có vùng che thì không nền, viền mỏng)
  const cur = style || startingStyle(coverOn);
  const set = <K extends keyof SubStyle>(k: K, v: SubStyle[K]) => onStyle({ ...cur, [k]: v });
  const mine = new Set(fonts.map((f) => f.family));
  const sys = systemFonts.filter((f) => !mine.has(f));
  const fontKnown = mine.has(cur.font) || systemFonts.includes(cur.font);

  return (
    <div className="field sub-studio">
      <span className="label">Phụ đề Việt</span>
      <div className="sub-toggles">
        <label className="check">
          <input type="checkbox" checked={burn} onChange={(e) => onBurn(e.target.checked)} /> In cứng phụ đề Việt
        </label>
        <label className="check">
          <input type="checkbox" checked={coverOn} onChange={(e) => onSubcover(e.target.checked ? "" : "none")} /> Che phụ đề gốc
        </label>
      </div>

      {show ? (
        <>
          <div className="rp">
            <div
              ref={stage}
              className={`rp-stage sub-stage ${coverOn ? "pickable" : ""} ${loading ? "loading" : ""}`}
              onPointerDown={(e) => {
                if (!coverOn || !size || e.button > 0) return;
                e.preventDefault();
                start.current = pt(e);
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const s0 = start.current;
                if (!s0) return;
                const p = pt(e);
                setSel({ x: Math.min(s0.x, p.x), y: Math.min(s0.y, p.y), w: Math.abs(p.x - s0.x), h: Math.abs(p.y - s0.y) });
              }}
              onPointerUp={() => {
                if (!start.current) return;
                start.current = null;
                // Bấm trơn không kéo thì không tính là vùng.
                if (sel && size && sel.w * size.W >= 4 && sel.h * size.H >= 4) commit(sel);
                else commit(null);
              }}
              onPointerCancel={() => (start.current = null)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {url && (
                <img
                  src={url}
                  alt="Xem trước phụ đề"
                  draggable={false}
                  onLoad={(e) => setSize({ W: e.currentTarget.naturalWidth, H: e.currentTarget.naturalHeight })}
                />
              )}
              {sel && <div className="rp-box" style={{ left: `${sel.x * 100}%`, top: `${sel.y * 100}%`, width: `${sel.w * 100}%`, height: `${sel.h * 100}%` }} />}
              {coverOn && !sel && url && <div className="sub-hint">Kéo chuột trên khung hình để khoanh vùng chữ Trung</div>}
              {(error || (loading && !url)) && <div className="rp-loading">{error || "Đang vẽ bản xem trước…"}</div>}
              {loading && url && <span className="sub-spin" aria-hidden="true" />}
            </div>
            <div className="rp-bar">
              <span className="rp-info muted">
                {coverOn
                  ? px && size
                    ? `Khung phụ đề ${px.w}×${px.h}px tại (${px.x}, ${px.y}) · phụ đề Việt hiện ngay trong khung này`
                    : "Vùng chữ Trung sẽ được làm mờ, phụ đề Việt hiện ngay trong khung."
                  : "Phụ đề hiện ở đáy video. Bật “Che phụ đề gốc” để tự chọn vị trí."}
              </span>
              {sel && (
                <button className="btn btn-quiet btn-sm" type="button" onClick={() => commit(null)}>
                  Chọn lại
                </button>
              )}
            </div>
          </div>

          {burn && (
            <div className="sub-panel">
              <div className="sub-presets" role="group" aria-label="Kiểu dựng sẵn">
                {PRESETS.map((p) => {
                  const on = sameStyle(style, p.style);
                  return (
                    <button
                      key={p.name}
                      type="button"
                      className={`chip ${on ? "active" : ""}`}
                      onClick={() => onStyle(p.style === null ? null : { ...cur, ...p.style } as SubStyle)}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
              <div className="sub-row">
                <select className="select" aria-label="Font chữ" value={cur.font} onChange={(e) => set("font", e.target.value)}>
                  {!fontKnown && <option value={cur.font}>{cur.font} (không còn trong máy)</option>}
                  {fonts.length > 0 && (
                    <optgroup label="Font của bạn (Tài nguyên)">
                      {[...mine].map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Có sẵn trong máy">
                    {sys.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <button type="button" className={`chip bold-chip ${cur.bold ? "active" : ""}`} aria-pressed={cur.bold} title="In đậm" onClick={() => set("bold", !cur.bold)}>
                  B
                </button>
                <Link className="sub-more" href="/resources/" title="Tải thêm font ở mục Tài nguyên">
                  <Icon name="type" size={15} /> Thêm font
                </Link>
              </div>
              <div className="sw-grid">
                <div className="sw-card">
                  <div className="sw-head">
                    <Icon name="type" size={15} />
                    <span>Cỡ chữ</span>
                  </div>
                  <Mini label="Cỡ chữ" value={cur.size_pct} min={50} max={200} step={5} unit="%" onChange={(v) => set("size_pct", v)} />
                </div>
                <Swatch label="Màu chữ" value={cur.color} onChange={(v) => set("color", v)} />
                <Swatch label="Viền chữ" value={cur.outline} onChange={(v) => set("outline", v)}>
                  <Mini label="Độ dày viền" value={cur.outline_width} min={0} max={8} step={0.5} unit="" onChange={(v) => set("outline_width", v)} />
                </Swatch>
                <Swatch label="Nền" value={cur.bg} onChange={(v) => set("bg", v)}>
                  <Mini label="Độ đặc của nền" value={cur.bg_opacity} min={0} max={100} step={5} unit="%" onChange={(v) => set("bg_opacity", v)} />
                </Swatch>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="help">Phụ đề Việt đang tắt: video giữ nguyên hình. Bật để xem trước và chỉnh kiểu chữ.</div>
      )}
    </div>
  );
}
