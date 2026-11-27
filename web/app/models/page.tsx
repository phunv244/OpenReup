"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { EmptyState } from "@/components/ui";
import { AsrModel, GpuInfo, GpuTier, VadModel, postJSON } from "@/lib/api";
import { ASR_BENCH, ASR_RECOMMENDED } from "@/lib/asr";
import { useStudio } from "@/lib/studio";

/** Nhóm theo bộ máy nhận diện (thay cho nhãn lặp ở từng thẻ). */
const ENGINES = [
  ["whisper", "Whisper", "faster-whisper · tự chạy trên GPU nếu có"],
  ["sherpa", "sherpa-onnx", "SenseVoice, Paraformer, FireRedASR · dùng bộ lọc giọng nói (VAD) bên dưới"],
] as const;

const TIER_META = [
  { key: "stt", title: "Nhận diện", sub: "STT · Whisper", icon: "wave" },
  { key: "tts", title: "Giọng đọc", sub: "TTS · VieNeu", icon: "mic" },
  { key: "nvenc", title: "Xuất video", sub: "Render · NVENC", icon: "film" },
] as const;

const sizeText = (mb: number) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

function GpuHealthSkeleton() {
  return (
    <section className="gpu-health gpu-health-skeleton" aria-busy="true" aria-label="Đang kiểm tra sức khỏe GPU">
      <div className="gpu-health-head">
        <div className="gpu-health-title">
          <span className="gpu-skel gpu-skel-ico" />
          <div className="gpu-health-meta">
            <span className="gpu-skel gpu-skel-h" />
            <span className="gpu-skel gpu-skel-sub" />
          </div>
        </div>
        <div className="gpu-health-right">
          <span className="gpu-skel gpu-skel-badge" />
          <span className="gpu-skel gpu-skel-btn" />
        </div>
      </div>
      <div className="gpu-tier-grid">
        {TIER_META.map((m) => (
          <div key={m.key} className="gpu-tier">
            <div className="gpu-tier-top">
              <span className="gpu-skel gpu-skel-tier-t" />
              <span className="gpu-skel gpu-skel-tier-b" />
            </div>
            <span className="gpu-skel gpu-skel-tier-d" />
          </div>
        ))}
      </div>
    </section>
  );
}

function tierBadgeLabel(t: GpuTier) {
  if (t.gpu) return `GPU · ${t.backend}`;
  return /cpu/i.test(t.backend) ? t.backend : `CPU · ${t.backend}`;
}

function GpuHealthCard({
  gpu,
  error,
  hasModels,
  onRefresh,
  refreshing,
}: {
  gpu: GpuInfo;
  error?: string;
  hasModels: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const hasTiers = Boolean(gpu.tiers?.stt && gpu.tiers?.tts && gpu.tiers?.nvenc);
  const hasHardware = Boolean(gpu.name);
  const total = gpu.total_tiers ?? 3;
  const active =
    gpu.active_tiers ??
    (hasTiers && gpu.tiers ? [gpu.tiers.stt, gpu.tiers.tts, gpu.tiers.nvenc].filter((t) => t.gpu).length : gpu.cuda ? 1 : 0);

  const isError = Boolean(error && !hasModels && !hasTiers && !hasHardware);

  let statusIcon: "sparkles" | "alert" | "info" = "info";
  let statusTone = "muted";
  let summaryText = "Chạy CPU";
  let summaryClass = "badge";

  if (isError) {
    statusIcon = "alert";
    statusTone = "amber";
    summaryText = "Lỗi kiểm tra";
    summaryClass = "badge amber";
  } else if (hasTiers) {
    if (active >= total) {
      statusIcon = "sparkles";
      statusTone = "green";
      summaryText = `${active}/${total} tầng GPU`;
      summaryClass = "badge green";
    } else if (active > 0 || hasHardware) {
      statusIcon = "alert";
      statusTone = "amber";
      summaryText = `${active}/${total} tầng GPU`;
      summaryClass = "badge amber";
    } else {
      statusIcon = "info";
      statusTone = "muted";
      summaryText = "Chạy CPU";
      summaryClass = "badge";
    }
  } else {
    statusIcon = gpu.cuda ? "sparkles" : hasHardware ? "alert" : "info";
    statusTone = gpu.cuda ? "green" : hasHardware ? "amber" : "muted";
    summaryText = "Cơ bản";
    summaryClass = gpu.cuda ? "badge green" : "badge";
  }

  const hwSubtitle = hasHardware
    ? `${gpu.name}${gpu.vram_gb ? ` · ${Number(gpu.vram_gb).toFixed(1)} GB VRAM` : ""}`
    : isError
      ? "Không đọc được thông tin phần cứng từ máy chủ"
      : "Không phát hiện GPU NVIDIA";

  return (
    <section className={`gpu-health ${isError ? "is-error" : ""}`} aria-label="Sức khỏe GPU">
      <div className="gpu-health-head">
        <div className="gpu-health-title">
          <span className={`gpu-health-ico tone-${statusTone}`}>
            <Icon name={statusIcon} size={18} />
          </span>
          <div className="gpu-health-meta">
            <h2 className="gpu-health-heading">Sức khỏe GPU</h2>
            <p className="gpu-health-hw">{hwSubtitle}</p>
          </div>
        </div>
        <div className="gpu-health-right">
          <span className={summaryClass}>{summaryText}</span>
          {isError ? (
            <button className="btn btn-light btn-sm" type="button" onClick={onRefresh} disabled={refreshing}>
              <Icon name="refresh" size={14} /> {refreshing ? "Đang thử..." : "Thử lại"}
            </button>
          ) : (
            <button
              className={`icon-btn gpu-refresh-btn ${refreshing ? "is-spinning" : ""}`}
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Kiểm tra lại trạng thái GPU"
              title="Kiểm tra lại trạng thái GPU"
            >
              <Icon name="refresh" size={16} />
            </button>
          )}
        </div>
      </div>

      {isError ? (
        <p className="gpu-health-note">{error}</p>
      ) : hasTiers && gpu.tiers ? (
        <div className="gpu-tier-grid">
          {TIER_META.map((meta) => {
            const tier = gpu.tiers![meta.key];
            const warn = hasHardware && !tier.gpu;
            const badgeCls = tier.gpu ? "badge green" : warn ? "badge amber" : "badge";
            const line = !tier.gpu && tier.reason ? tier.reason : tier.detail;
            return (
              <div key={meta.key} className={`gpu-tier ${warn ? "is-warn" : ""}`}>
                <div className="gpu-tier-top">
                  <div className="gpu-tier-name">
                    <Icon name={meta.icon} size={15} />
                    <span>{meta.title}</span>
                    <span className="gpu-tier-sub">{meta.sub}</span>
                  </div>
                  <span className={badgeCls}>{tierBadgeLabel(tier)}</span>
                </div>
                <p className="gpu-tier-detail">{line}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="gpu-health-note">
          {gpu.cuda
            ? "Phát hiện CUDA: các mô hình Whisper chạy trên GPU (API phiên bản cơ bản chưa có chi tiết 3 tầng)."
            : hasHardware
              ? "Thấy GPU NVIDIA nhưng faster-whisper chưa dùng được CUDA; các mô hình đang chạy CPU."
              : "Máy này không có GPU NVIDIA: mọi mô hình chạy trên CPU."}
        </p>
      )}
    </section>
  );
}

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
  const { asr, loaded, refreshAsr } = useStudio();
  const [refreshing, setRefreshing] = useState(false);
  const top = <Topbar title="Mô hình nhận diện" />;

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshAsr();
    } finally {
      setRefreshing(false);
    }
  };

  if (!loaded) {
    return (
      <>
        {top}
        <main className="content">
          <GpuHealthSkeleton />
        </main>
      </>
    );
  }

  return (
    <>
      {top}
      <main className="content">
        <GpuHealthCard
          gpu={asr.gpu}
          error={asr.error}
          hasModels={asr.models.length > 0}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
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
          <EmptyState icon="brain" title="Chưa đọc được danh sách mô hình" desc="Kiểm tra môi trường Python (.venv) rồi bấm Thử lại hoặc tải lại trang." />
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
