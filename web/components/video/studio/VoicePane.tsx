"use client";
/** Tab "Giọng đọc": một giọng chung, hoặc giọng từng nhân vật khi video lồng nhiều giọng; âm lượng nền. */
import { Icon } from "@/components/Icon";
import { Options } from "@/components/ui";
import { Project } from "@/lib/api";
import { useStudio } from "@/lib/studio";
import { voiceOptions } from "@/lib/voices";
import { OriginalAudioSlider } from "./OriginalAudioSlider";
import type { DubDetail } from "./useDubDetail";

export function VoicePane({ s, proj }: { s: DubDetail; proj: Project | undefined }) {
  const { voices } = useStudio();
  const allVoices = [...voices.clones, ...voices.presets];
  const { info, speakers, voice, setVoice, spkVoices, setSpkVoices, bg, setBg } = s;
  if (!info) return null;

  // Dự án dùng 1 giọng chung cho mọi nhân vật — nút này áp giọng đó cho các nhân vật (cũ) đang khác giọng.
  const projVoice = proj?.voice || "";
  const ctxList = speakers.map(([k]) => [k, projVoice] as const).filter(([k, v]) => v && v !== (spkVoices[k] || info.speakers![k].voice));
  const ctxVoices = ctxList.length ? Object.fromEntries(ctxList) : null;

  return (
    <>
      {!speakers.length ? (
        <div className="field">
          <label htmlFor="dt-voice">Giọng đọc</label>
          <select id="dt-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
            <Options list={voiceOptions(allVoices, proj, info.voice)} />
          </select>
        </div>
      ) : (
        <div className="field">
          {speakers.map(([k, sp]) => (
            <div className="spk-row" key={k}>
              <span className={`spk-tag spk-${Number(k.replace(/\D/g, "")) || 1}`}>{k}</span>
              <span className="muted spk-meta">
                <b className="spk-name">{sp.name || "Chưa rõ là ai"}</b>
                {sp.is_new && <span className="badge amber">Nhân vật mới</span>} · {sp.lines || 0} câu
              </span>
              <select
                className="select input-sm"
                aria-label={`Giọng của ${k}`}
                value={spkVoices[k] || sp.voice}
                onChange={(e) => setSpkVoices({ ...spkVoices, [k]: e.target.value })}
              >
                <Options list={voiceOptions(allVoices, proj, sp.voice)} />
              </select>
            </div>
          ))}
          {ctxVoices && (
            <button className="btn btn-light btn-sm" type="button" onClick={() => setSpkVoices({ ...spkVoices, ...ctxVoices })}>
              <Icon name="brain" size={14} /> Lấy giọng theo Ngữ cảnh AI
            </button>
          )}
          <div className="help">Giọng đổi ở đây chỉ áp dụng cho video này. Giọng chung của dự án đặt trong Ngữ cảnh AI → Thông tin.</div>
        </div>
      )}
      <OriginalAudioSlider
        id="dt-bg"
        label="Âm thanh gốc làm nền"
        valuePct={Math.round(Number(bg || 0) * 100)}
        onChangePct={(pct) => setBg(String(Number((pct / 100).toFixed(2))))}
      />
    </>
  );
}
