"use client";
/** Thanh kéo âm lượng âm thanh gốc 0–200% (step=5) + 4 preset nhanh + cảnh báo var(--amber) & badge limiter khi >100%. */

export const ORIGINAL_AUDIO_PRESETS = [
  { pct: 0, label: "Tắt" },
  { pct: 20, label: "Nền nhẹ" },
  { pct: 100, label: "Gốc" },
  { pct: 150, label: "Kích lớn" },
] as const;

export function OriginalAudioSlider({
  id = "orig-audio-vol",
  label = "Âm thanh gốc làm nền",
  valuePct,
  onChangePct,
}: {
  id?: string;
  label?: string;
  valuePct: number;
  onChangePct: (pct: number) => void;
}) {
  const safePct = Math.min(200, Math.max(0, Math.round(Number.isFinite(valuePct) ? valuePct : 20)));
  const amplified = safePct > 100;

  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <label htmlFor={id} style={{ margin: 0 }}>
          {label}
        </label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: 13, color: amplified ? "var(--amber)" : undefined }}>
            {safePct}%
          </strong>
          {amplified && (
            <span
              className="badge amber"
              style={{
                color: "var(--amber)",
                border: "1px solid var(--amber)",
                background: "color-mix(in srgb, var(--amber) 14%, transparent)",
                fontSize: 11,
                padding: "2px 7px",
                borderRadius: 999,
              }}
            >
              Khuếch đại · Có limiter
            </span>
          )}
        </span>
      </div>

      <input
        id={id}
        type="range"
        min={0}
        max={200}
        step={5}
        value={safePct}
        onChange={(e) => onChangePct(Number(e.target.value))}
        style={{
          width: "100%",
          accentColor: amplified ? "var(--amber)" : undefined,
          cursor: "pointer",
        }}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={200}
        aria-valuenow={safePct}
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {ORIGINAL_AUDIO_PRESETS.map((p) => {
          const active = safePct === p.pct;
          return (
            <button
              key={p.pct}
              type="button"
              className={`btn btn-sm ${active ? "btn-primary" : "btn-light"}`}
              onClick={() => onChangePct(p.pct)}
              style={
                active && p.pct > 100
                  ? { background: "var(--amber)", borderColor: "var(--amber)", color: "#111" }
                  : undefined
              }
            >
              {p.pct}% {p.label}
            </button>
          );
        })}
      </div>

      {amplified ? (
        <div className="help" style={{ color: "var(--amber)", marginTop: 4 }}>
          Đang khuếch đại tiếng gốc trên 100%. Hệ thống tự gắn alimiter chống vỡ tiếng và chuẩn hóa đầu ra -14 LUFS.
        </div>
      ) : (
        <div className="help" style={{ marginTop: 4 }}>
          {safePct === 0
            ? "Tắt hoàn toàn âm thanh gốc, chỉ giữ giọng lồng tiếng."
            : "Giữ âm thanh gốc ở mức an toàn kết hợp tự động giảm nền (ducking) khi có lời thoại."}
        </div>
      )}
    </div>
  );
}
