"use client";
/** Cấu hình rồi bắt đầu (hoặc chạy tiếp) lồng tiếng 1 video. */
import Link from "next/link";
import { useState } from "react";
import { DubParams, SubStyle } from "@/lib/api";
import { asrTag, pickModel } from "@/lib/asr";
import { fmtHours, projHref } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { voiceOptions } from "@/lib/voices";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { RegionToggle } from "../RegionPicker";
import { useToast } from "../Toasts";
import { Callout, Options } from "../ui";
import { AgyModelField } from "./AgyModelField";
import { SubtitleStudio } from "./SubtitleStudio";
import { WorkItem } from "./items";

export function DubConfigModal({ v, projectId, onClose }: { v: WorkItem; projectId: string; onClose: () => void }) {
  const toast = useToast();
  const { projects, voices, asr, system, startTask } = useStudio();
  const proj = projects.find((p) => p.id === projectId);
  const prev: DubParams = v.job?.params || v.dub || {};
  const resumable = Boolean(v.job && v.job.status !== "done");
  const allVoices = [...voices.clones, ...voices.presets];

  const [f, setF] = useState({
    voice: prev.voice || proj?.voices?.[0] || allVoices[0]?.id || "",
    model: pickModel(asr, prev.model || ""),
    speed: String(prev.speed ?? 0.5),
    bg: String(prev.bg_volume ?? 0.05),
    sub: prev.burn_sub !== false,
    multi: prev.multi_voice !== false,
    fresh: false,
    agy: prev.agy_model || "",
  });
  const [delogo, setDelogo] = useState(prev.delogo || "none");
  const [subcover, setSubcover] = useState(prev.subcover || "none");
  const [subStyle, setSubStyle] = useState<SubStyle | null>(prev.sub_style || null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  // Ước tính sơ bộ: chỉ để người dùng biết nên để máy chạy qua đêm hay không.
  const dur = Number(v.duration_sec || 0);
  const encode = f.sub || delogo !== "none" || subcover !== "none";
  const slow = 0.5 / Number(f.speed);
  // VieNeu trên CPU: ~1,5 giây máy cho 1 giây lời, lời chiếm ~55% thời lượng video.
  const vieneu = f.voice.startsWith("vieneu") || f.multi ? 0.8 : 0;
  const m = asr.models.find((x) => x.id === f.model);
  // Đo trên máy 4 nhân, video 8 phút: SenseVoice ~0,07; Paraformer ~0,05; Whisper base ~0,3; small ~1,0 (x thời lượng)
  const sttCost = ({ "sensevoice-small": 0.07, "paraformer-zh": 0.05, base: 0.3 * slow, small: 1.0 * slow } as Record<string, number>)[m?.id || ""]
    ?? (m?.hw === "gpu" ? 2 : 0.5);
  const factor = sttCost + (encode ? 0.3 : 0.03) + 0.08 + vieneu;
  const needGb = (v.size_mb / 1024) * (encode ? 2.2 : 1.15) + 0.5;
  const lowDisk = system.free_gb && system.free_gb < needGb;

  async function run() {
    if (!asr.models.find((x) => x.id === f.model)?.installed) return toast("Mô hình nhận diện này chưa tải về. Mở mục Mô hình nhận diện để tải.", "error");
    if (!delogo) return toast("Hãy kéo chuột trên khung hình để khoanh vùng logo", "error");
    if (!subcover) return toast("Hãy kéo chuột trên khung hình để khoanh vùng phụ đề gốc", "error");
    const ok = await startTask(
      "/api/dub/start",
      {
        project_id: projectId,
        rel_path: v.rel_path,
        speed: Number(f.speed),
        voice: f.voice,
        model: f.model,
        bg_volume: Number(f.bg),
        delogo,
        subcover,
        sub_style: f.sub ? subStyle : null,
        burn_sub: f.sub,
        multi_voice: f.multi,
        agy_model: f.agy,
        fresh: f.fresh,
      },
      resumable ? "Đang chạy tiếp từ chỗ đang dở" : "Đã bắt đầu dịch & lồng tiếng"
    );
    if (ok) onClose();
  }

  return (
    <Modal title={`Lồng tiếng · ${v.title}`} onClose={onClose} size="wide">
      {resumable ? (
        <Callout tone="warn" icon="clock">
          Video này đang làm dở ở <b>{Math.round(v.job!.pct)}%</b>. Bấm bắt đầu sẽ <b>chạy tiếp</b> từ chỗ đang dở.
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={f.fresh} onChange={set("fresh")} /> Bỏ kết quả dở, nhận diện và dịch lại từ đầu
          </label>
        </Callout>
      ) : v.dub ? (
        <Callout tone="warn" icon="alert">
          Lồng tiếng lại sẽ <b>nhận diện và dịch lại từ đầu</b>: các câu bạn đã sửa tay trong bản hiện tại sẽ bị thay thế. Nếu chỉ muốn đổi giọng / phụ đề /
          logo, hãy dùng <b>Sửa lời → Lưu & xuất lại</b>.
        </Callout>
      ) : (
        <Callout tone="info" icon="brain">
          Dự án <b>{proj?.name || "—"}</b>: AI đọc ngữ cảnh dự án, tự sửa lỗi nghe nhầm, dịch đúng xưng hô và ghi nhớ nhân vật mới.
        </Callout>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="mc-voice">Giọng lồng tiếng</label>
          <select id="mc-voice" className="select" value={f.voice} onChange={set("voice")}>
            <Options list={voiceOptions(allVoices, proj, prev.voice)} />
          </select>
          <div className="help">
            Quản lý ở mục <Link href={projHref(projectId, "voices")}>Giọng đọc</Link> của dự án.
          </div>
        </div>
        <div className="field">
          <label htmlFor="mc-model">Mô hình nhận diện tiếng Trung</label>
          <select id="mc-model" className="select" value={f.model} onChange={set("model")}>
            {asr.models.map((x) => (
              <option key={x.id} value={x.id} disabled={!x.installed}>
                {x.name + asrTag(asr, x.id)}
              </option>
            ))}
          </select>
          <div className="help">
            Tải thêm / xem so sánh ở mục <Link href="/models/">Mô hình nhận diện</Link>.
          </div>
        </div>
        <AgyModelField value={f.agy} onChange={(agy) => setF((x) => ({ ...x, agy }))} />
        <div className="field">
          <label htmlFor="mc-speed">Làm chậm khi tách lời</label>
          <select id="mc-speed" className="select" value={f.speed} onChange={set("speed")}>
            <Options list={[["0.5", "0.5x — thoại nhanh, nói dồn dập"], ["0.65", "0.65x"], ["0.8", "0.8x"], ["1", "1.0x — không làm chậm, nhanh gấp đôi"]]} />
          </select>
          <div className="help">Chỉ dùng cho Whisper. Video xuất ra luôn ở tốc độ gốc.</div>
        </div>
        <div className="field">
          <label htmlFor="mc-bg">Âm thanh gốc làm nền</label>
          <select id="mc-bg" className="select" value={f.bg} onChange={set("bg")}>
            <Options list={[["0.05", "5% — rất nhỏ"], ["0", "Tắt hẳn"], ["0.12", "12% — rõ tiếng động nền"]]} />
          </select>
        </div>
        <div className="field">
          <span className="label">Giọng nhân vật</span>
          <label className="check">
            <input type="checkbox" checked={f.multi} onChange={set("multi")} /> Mỗi nhân vật một giọng (tự nhận diện)
          </label>
          <div className="help">
            Nghe giọng gốc để tách nhân vật. Người nói nhiều nhất dùng giọng đã chọn, người khác tự nhận giọng VieNeu nam / nữ — đổi lại được trong{" "}
            <b>Sửa lời</b>.
          </div>
        </div>
      </div>
      <RegionToggle label="Xóa logo khi xuất" rel={v.rel_path} initial={prev.delogo} onChange={setDelogo} />
      <SubtitleStudio
        rel={v.rel_path}
        burn={f.sub}
        onBurn={(sub) => setF((x) => ({ ...x, sub }))}
        subcover={subcover}
        initialSubcover={prev.subcover}
        onSubcover={setSubcover}
        style={subStyle}
        onStyle={setSubStyle}
      />
      {dur > 600 && (
        <Callout tone="info" icon="clock">
          Video dài <b>{fmtHours(dur)}</b> — ước tính xử lý khoảng <b>{fmtHours(dur * factor)}</b> (tùy máy và mạng). Tiến độ được lưu liên tục: dừng, tắt máy
          hay mất mạng đều <b>chạy tiếp được</b> từ chỗ đang dở.
        </Callout>
      )}
      {lowDisk ? (
        <Callout tone="danger" icon="disk">
          Cần khoảng <b>{needGb.toFixed(1)} GB</b> trống nhưng ổ cứng chỉ còn <b>{system.free_gb} GB</b>. Hãy xóa bớt video cũ
          {encode ? " hoặc tắt in phụ đề / xóa logo" : ""}.
        </Callout>
      ) : null}
      <div className="modal-foot">
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" type="button" onClick={run}>
          <Icon name="mic" size={16} /> {resumable ? "Tiếp tục lồng tiếng" : "Bắt đầu lồng tiếng"}
        </button>
      </div>
    </Modal>
  );
}
