"use client";
/**
 * Phụ đề Việt: bật/tắt in phụ đề, che phụ đề gốc, kiểu dựng sẵn và kiểu chữ.
 * Vùng chữ Trung được khoanh trên khung hình lớn của trang — vùng đó được làm mờ và cũng là khung hiện phụ đề Việt.
 */
import Link from "next/link";
import { SubStyle } from "@/lib/api";
import { useStudio } from "@/lib/studio";
import { isRegionValue, startingStyle } from "@/lib/subtitle";
import { Icon } from "../Icon";

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
  burn: boolean;
  onBurn: (v: boolean) => void;
  /** "none" = không che; "" = đã bật che nhưng chưa khoanh (bên gọi phải chặn); "x,y,w,h" = vùng đã khoanh */
  subcover: string;
  onSubcover: (v: string) => void;
  /** Chuyển khung hình lớn sang khoanh vùng phụ đề gốc. */
  onPick: () => void;
  style: SubStyle | null;
  onStyle: (s: SubStyle | null) => void;
};

/** Các nút chỉnh phụ đề Việt. Ảnh xem trước và việc khoanh vùng nằm trên khung hình lớn của trang (FrameStage). */
export function SubtitleStudio({ burn, onBurn, subcover, onSubcover, onPick, style, onStyle }: Props) {
  const { fonts, systemFonts } = useStudio();
  const coverOn = subcover !== "none";

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
          <input
            type="checkbox"
            checked={coverOn}
            onChange={(e) => {
              onSubcover(e.target.checked ? "" : "none");
              if (e.target.checked) onPick();
            }}
          />{" "}
          Che phụ đề gốc
        </label>
      </div>

      {coverOn && (
        <div className="region-row">
          <span className="fs-dot sub" />
          <span className="muted">
            {isRegionValue(subcover)
              ? `Vùng ${subcover.split(",").slice(2).join("×")}px — chữ Trung được làm mờ, phụ đề Việt hiện trong vùng này.`
              : "Chưa khoanh — kéo chuột trên khung hình lớn để khoanh vùng chữ Trung."}
          </span>
          <button className="btn btn-quiet btn-sm" type="button" onClick={onPick}>
            {isRegionValue(subcover) ? "Khoanh lại" : "Khoanh"}
          </button>
        </div>
      )}
      {!coverOn && burn && <div className="help">Phụ đề hiện ở đáy video. Bật “Che phụ đề gốc” để tự chọn vị trí.</div>}

      {burn || coverOn ? (
        <>
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
