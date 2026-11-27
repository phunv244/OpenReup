"use client";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { Callout, EmptyState } from "@/components/ui";
import { AsrModel, VadModel, postJSON } from "@/lib/api";
import { ASR_BENCH, ASR_RECOMMENDED } from "@/lib/asr";
import { useStudio } from "@/lib/studio";

/** Nhóm theo bộ máy nhận diện (thay cho nhãn lặp ở từng thẻ). */
const ENGINES = [
  ["whisper", "Whisper", "faster-whisper · tự chạy trên GPU nếu có"],
  ["sherpa", "sherpa-onnx", "SenseVoice, Paraformer, FireRedASR · dùng bộ lọc giọng nói (VAD) bên dưới"],
] as const;

const sizeText = (mb: number) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

function ModelCard({ m }: { m: AsrModel }) {
  const { asr, startTask } = useStudio();
  const b = ASR_BENCH[m.id];
  const size = sizeText(m.size_mb);
  return (
    <article className={`model-card ${m.installed ? "installed" : ""}`}>
      <div className="model-head">
        <h3>{m.name}</h3>
        {m.id === ASR_RECOMMENDED && (
          <span className="badge violet">
            <Icon name="check" size={13} /> Khuyên dùng
          </span>
        )}
      </div>
      {/* Nhãn chỉ cho ngoại lệ: cần GPU (cam khi máy không có CUDA). Bộ máy nhận diện đã là tiêu đề nhóm; dung lượng ở chân thẻ. */}
      {m.hw === "gpu" && (
        <div className="model-badges">
          <span className={`badge ${asr.gpu.cuda ? "gray" : "amber"}`}>Nên có GPU · ~{m.vram_gb} GB VRAM</span>
        </div>
      )}
      <p className="model-desc">{m.desc}</p>
      {b && (
        <p className="model-bench muted">
          Đo trên máy này, video 8 phút: {b.sec} giây · sót {b.miss}% lời thoại · {b.note}
        </p>
      )}
      <div className="model-foot">
        {m.installed ? (
          <span className="badge green">
            <Icon name="check" size={13} /> Đã tải · {size}
          </span>
        ) : (
          <button className="btn btn-light btn-sm" type="button" onClick={() => startTask("/api/asr-models/download", { id: m.id }, "Bắt đầu tải mô hình")}>
            <Icon name="download" size={15} /> Tải về ({size})
          </button>
        )}
      </div>
    </article>
  );
}

function VadRow({ v }: { v: VadModel }) {
  const toast = useToast();
  const { asr, startTask, reload } = useStudio();
  const on = asr.vad === v.id;
  return (
    <div className={`voice-row ${on ? "picked" : ""}`}>
      <label className="check voice-pick">
        <input
          type="radio"
          name="vad"
          checked={on}
          disabled={!v.installed}
          aria-label={`Dùng ${v.name}`}
          onChange={async () => {
            const d = await postJSON("/api/asr-models/vad", { id: v.id });
            if (!d.ok) return toast(d.error || "Không đổi được bộ lọc", "error");
            toast("Đã đổi bộ lọc giọng nói", "success");
            reload();
          }}
        />
      </label>
      <div className="voice-main">
        <div className="voice-name">
          {v.name}{" "}
          {v.id === "firered-vad" && (
            <span className="badge violet">
              <Icon name="check" size={13} /> Khuyên dùng
            </span>
          )}{" "}
          {on && <span className="badge green">Đang dùng</span>}
        </div>
        <div className="model-desc">{v.desc}</div>
      </div>
      <div className="voice-actions">
        {v.installed ? (
          <span className="badge green">
            <Icon name="check" size={13} /> Đã tải
          </span>
        ) : (
          <button className="btn btn-light btn-sm" type="button" onClick={() => startTask("/api/asr-models/download", { id: v.id }, "Bắt đầu tải mô hình")}>
            <Icon name="download" size={15} /> Tải về{v.extra ? ` (+ ${v.extra})` : ""}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const { asr, loaded } = useStudio();
  const g = asr.gpu;
  const top = <Topbar title="Mô hình nhận diện" />;
  // Chưa tải xong thì chưa biết có GPU / có mô hình hay không: không hiện cảnh báo hay lỗi sớm.
  if (!loaded) return top;
  return (
    <>
      {top}
      <main className="content">
        {g.cuda ? (
          <Callout tone="info" icon="sparkles">
            Máy này có GPU <b>{g.name}</b>
            {g.vram_gb ? ` (${g.vram_gb} GB)` : ""}: các mô hình Whisper tự chạy trên GPU.
          </Callout>
        ) : g.name ? (
          <Callout tone="warn" icon="info">
            Thấy GPU <b>{g.name}</b> nhưng faster-whisper chưa dùng được CUDA (thiếu thư viện CUDA/cuDNN). Các mô hình đang chạy trên CPU.
          </Callout>
        ) : (
          <Callout tone="warn" icon="info">
            Máy này không có GPU NVIDIA: mọi mô hình chạy trên CPU. Mô hình gắn nhãn <b>Nên có GPU</b> vẫn tải và chạy được nhưng rất chậm — hợp để tải sẵn
            rồi dùng trên máy có GPU.
          </Callout>
        )}
        {asr.models.length ? (
          ENGINES.map(([engine, title, hint]) => {
            const list = asr.models.filter((m) => (m.engine === "whisper") === (engine === "whisper"));
            return list.length ? (
              <section key={engine} className="model-group">
                <header className="model-group-head">
                  <h2>{title}</h2>
                  <span className="hint">{hint}</span>
                </header>
                <div className="model-grid">
                  {list.map((m) => (
                    <ModelCard key={m.id} m={m} />
                  ))}
                </div>
              </section>
            ) : null;
          })
        ) : (
          <EmptyState icon="brain" title="Chưa đọc được danh sách mô hình" desc="Kiểm tra môi trường Python (.venv) rồi tải lại trang." />
        )}
        <section className="card model-vad">
          <header className="card-head">
            <h3>Bộ lọc giọng nói (VAD)</h3>
            <span className="hint">Cắt đoạn có tiếng nói trước khi nhận diện · áp dụng cho SenseVoice, Paraformer, FireRedASR</span>
          </header>
          {asr.vads.map((v) => (
            <VadRow key={v.id} v={v} />
          ))}
        </section>
      </main>
    </>
  );
}
