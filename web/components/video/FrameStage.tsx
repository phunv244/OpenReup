"use client";
/**
 * Khung hình xem trước DUY NHẤT trên sân khấu lớn của trang chi tiết (thay 2 ảnh nhỏ lặp nhau trong tab "Hình & phụ đề").
 * Ảnh do server vẽ bằng đúng bộ lọc lúc xuất (vùng che phụ đề gốc + phụ đề Việt mẫu). Kéo chuột trên khung để khoanh
 * vùng đang chọn (logo hoặc phụ đề gốc); cả 2 vùng cùng hiện trên một khung, mỗi vùng một màu.
 * Giá trị vùng là chuỗi "x,y,w,h" theo pixel gốc; "" = đã bật nhưng chưa khoanh; "none" = tắt.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SubStyle } from "@/lib/api";
import { isRegionValue } from "@/lib/subtitle";

export type RegionTarget = "logo" | "sub";
type Rect = { x: number; y: number; w: number; h: number }; // tỉ lệ 0..1

const LABEL: Record<RegionTarget, string> = { logo: "logo", sub: "phụ đề gốc" };

// ffmpeg báo lỗi nếu vùng chạm mép: giữ x,y ≥ 1 và chừa 1px ở mép phải/dưới.
function toPx(r: Rect, W: number, H: number) {
  const x = Math.min(Math.max(1, Math.round(r.x * W)), W - 6);
  const y = Math.min(Math.max(1, Math.round(r.y * H)), H - 6);
  return { x, y, w: Math.max(4, Math.min(Math.round(r.w * W), W - 1 - x)), h: Math.max(4, Math.min(Math.round(r.h * H), H - 1 - y)) };
}
const toRect = (v: string, W: number, H: number): Rect | null => {
  if (!isRegionValue(v)) return null;
  const [x, y, w, h] = v.split(",").map(Number);
  return { x: x / W, y: y / H, w: w / W, h: h / H };
};

type Props = {
  rel: string;
  burn: boolean;
  style: SubStyle | null;
  delogo: string;
  subcover: string;
  /** Vùng nào đang được khoanh khi kéo chuột (null = chỉ xem). */
  target: RegionTarget | null;
  onTarget: (t: RegionTarget) => void;
  onRegion: (t: RegionTarget, v: string) => void;
};

export function FrameStage({ rel, burn, style, delogo, subcover, target, onTarget, onRegion }: Props) {
  const coverOn = subcover !== "none";
  const logoOn = delogo !== "none";
  const cover = isRegionValue(subcover) ? subcover : "none";

  /* ---- ảnh: có phụ đề / vùng che thì nhờ server vẽ, không thì lấy khung hình trơn ---- */
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const rendered = burn || coverOn;
  const key = JSON.stringify([rel, rendered, cover, burn, style]);
  useEffect(() => {
    if (!rel) return;
    const ctl = new AbortController();
    setLoading(true);
    // Chờ 450 ms sau lần chỉnh cuối: kéo thanh trượt không dồn hàng chục yêu cầu vẽ.
    const t = setTimeout(async () => {
      try {
        const res = rendered
          ? await fetch("/api/sub-preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rel_path: rel, subcover: cover, style, burn }),
              signal: ctl.signal,
            })
          : await fetch(`/api/frame?rel=${encodeURIComponent(rel)}`, { signal: ctl.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Không lấy được khung hình — cần ffmpeg và file video gốc còn trên máy.");
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

  /* ---- vừa khít khung đen: tính đúng kích thước ảnh để khung khoanh vùng trùng với ảnh ---- */
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !size) return;
    const calc = () => {
      const s = Math.min(el.clientWidth / size.W, el.clientHeight / size.H);
      setFit({ w: Math.floor(size.W * s), h: Math.floor(size.H * s) });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  /* ---- kéo chuột khoanh vùng ---- */
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraftState] = useState<Rect | null>(null);
  const draftRef = useRef<Rect | null>(null); // đọc lúc thả chuột, không phụ thuộc lần vẽ lại
  const setDraft = (r: Rect | null) => {
    draftRef.current = r;
    setDraftState(r);
  };
  const pt = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rect = (t: RegionTarget) => (draft && target === t ? draft : size ? toRect(t === "logo" ? delogo : subcover, size.W, size.H) : null);
  const logoRect = logoOn ? rect("logo") : null;
  const subRect = coverOn ? rect("sub") : null;
  const pickable = Boolean(target && size);
  const missing = target && !(target === "logo" ? logoRect : subRect);

  return (
    <div className="frame-stage" ref={box}>
      {size && fit ? (
        <div
          ref={stage}
          className={`frame-fit ${pickable ? "pickable" : ""} ${loading ? "loading" : ""}`}
          style={{ width: fit.w, height: fit.h }}
          onPointerDown={(e) => {
            if (!pickable || e.button > 0) return;
            e.preventDefault();
            start.current = pt(e);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {}
          }}
          onPointerMove={(e) => {
            const s0 = start.current;
            if (!s0) return;
            const p = pt(e);
            setDraft({ x: Math.min(s0.x, p.x), y: Math.min(s0.y, p.y), w: Math.abs(p.x - s0.x), h: Math.abs(p.y - s0.y) });
          }}
          onPointerUp={() => {
            if (!start.current || !target || !size) return;
            start.current = null;
            // Bấm trơn không kéo thì không đổi vùng đang có.
            const d = draftRef.current;
            if (d && d.w * size.W >= 4 && d.h * size.H >= 4) onRegion(target, Object.values(toPx(d, size.W, size.H)).join(","));
            setDraft(null);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDraft(null);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Khung hình xem trước" draggable={false} />
          {logoRect && (
            <div className={`rp-box fs-box logo ${target === "logo" ? "on" : ""}`} style={pos(logoRect)}>
              <span>Logo</span>
            </div>
          )}
          {subRect && (
            <div className={`rp-box fs-box sub ${target === "sub" ? "on" : ""}`} style={pos(subRect)}>
              <span>Phụ đề gốc</span>
            </div>
          )}
          {loading && <span className="sub-spin" aria-hidden="true" />}
        </div>
      ) : (
        <div className="rp-loading">{error || "Đang lấy khung hình…"}</div>
      )}
      {/* Ảnh ẩn chỉ để đọc kích thước thật của khung hình */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && !size && <img hidden alt="" src={url} onLoad={(e) => setSize({ W: e.currentTarget.naturalWidth, H: e.currentTarget.naturalHeight })} />}

      <div className="fs-hud">
        {logoOn && coverOn && (
          <div className="seg fs-target" role="group" aria-label="Vùng đang khoanh">
            {(["logo", "sub"] as const).map((t) => (
              <button key={t} type="button" className={target === t ? "active" : ""} aria-pressed={target === t} onClick={() => onTarget(t)}>
                <span className={`fs-dot ${t}`} /> {t === "logo" ? "Logo" : "Phụ đề gốc"}
              </button>
            ))}
          </div>
        )}
        {missing ? (
          <span className="fs-hint">Kéo chuột trên khung hình để khoanh vùng {LABEL[target!]}</span>
        ) : target ? (
          <span className="fs-hint quiet">Kéo lại để đổi vùng {LABEL[target]}</span>
        ) : null}
      </div>
    </div>
  );
}

const pos = (r: Rect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

/** Vùng đã lưu -> giá trị trên form: "none" tắt, "x,y,w,h" đã khoanh, "" bật nhưng phải khoanh lại (bản cũ lưu vị trí góc). */
export const regionInit = (v?: string) => (!v || v === "none" ? "none" : isRegionValue(v) ? v : "");

/** Công tắc "Xóa logo" + dòng trạng thái vùng. Việc khoanh vùng diễn ra trên FrameStage. */
export function LogoToggle({ label = "Xóa logo", value, saved, onChange, onPick }: {
  label?: string;
  value: string;
  saved?: string;
  onChange: (v: string) => void;
  onPick: () => void;
}) {
  const on = value !== "none";
  const ok = isRegionValue(value);
  return (
    <div className="field">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            onChange(e.target.checked ? (isRegionValue(saved || "") ? String(saved) : "") : "none");
            if (e.target.checked) onPick();
          }}
        />{" "}
        {label}
      </label>
      {on && (
        <div className="region-row">
          <span className="fs-dot logo" />
          <span className="muted">
            {ok ? `Vùng ${value.split(",").slice(2).join("×")}px tại (${value.split(",").slice(0, 2).join(", ")})` : "Chưa khoanh — kéo chuột trên khung hình để khoanh vùng logo."}
          </span>
          <button className="btn btn-quiet btn-sm" type="button" onClick={onPick}>
            {ok ? "Khoanh lại" : "Khoanh"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Vùng nào đang khoanh: theo lựa chọn nếu vùng đó đang bật, không thì vùng bật đầu tiên. */
export const activeTarget = (want: RegionTarget | null, delogo: string, subcover: string): RegionTarget | null =>
  want === "logo" && delogo !== "none" ? "logo" : want === "sub" && subcover !== "none" ? "sub" : delogo !== "none" ? "logo" : subcover !== "none" ? "sub" : null;
