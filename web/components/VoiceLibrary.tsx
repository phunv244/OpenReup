"use client";
/** Thư viện giọng đọc dùng chung mọi dự án (mục con của Tài nguyên): clone giọng, nghe thử, đặt giới tính, xóa. */
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import { Callout, Options, Seg } from "@/components/ui";
import { Voice, postJSON, uploadFile } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { DEFAULT_PREVIEW_TEXT, GENDER_LABEL, playVoiceUrl } from "@/lib/voices";

/** Nút phát: hiện "Đang tạo…" trong lúc máy đọc thử lần đầu (10–20 giây). */
function PlayButton({ url, label, quiet }: { url: () => string; label: string; quiet?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`btn ${quiet ? "btn-quiet" : "btn-light"} btn-sm`}
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await playVoiceUrl(url());
        } catch (err) {
          toast((err as Error).message || "Không phát được âm thanh", "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={busy ? "clock" : "play"} size={15} /> {busy ? "Đang tạo…" : label}
    </button>
  );
}

function VoiceRow({ v, text }: { v: Voice; text: string }) {
  const toast = useToast();
  const { reload } = useStudio();
  const [gender, setGender] = useState(v.gender || "");
  const sub =
    v.kind === "clone"
      ? [v.source, v.f0 ? `~${v.f0} Hz` : "", v.end ? `đoạn ${fmtDur(v.start) || "0:00"}–${fmtDur(v.end)}` : ""].filter(Boolean).join(" · ")
      : `${GENDER_LABEL[v.gender]} · ${v.desc}`;

  async function remove() {
    if (!confirm(`Xóa giọng "${v.name}"?\n\nGiọng sẽ bị gỡ khỏi mọi dự án. Các video đã lồng tiếng bằng giọng này không bị ảnh hưởng.`)) return;
    const d = await postJSON("/api/voices/delete", { slug: v.slug });
    if (!d.ok) return toast(d.error || "Không xóa được giọng", "error");
    toast("Đã xóa giọng", "success");
    reload();
  }

  return (
    <div className="voice-row">
      <div className="voice-main">
        <div className="voice-name">
          {v.name} {v.kind === "clone" ? <span className="badge violet">Clone</span> : <span className="badge gray">VieNeu</span>}
        </div>
        <div className="voice-sub muted" title={sub}>
          {sub}
        </div>
      </div>
      <div className="voice-actions">
        {v.kind === "clone" && (
          <>
            <select
              className="select input-sm"
              aria-label={`Giới tính của giọng ${v.name}`}
              title="Dùng khi tự chia giọng cho nhân vật nam / nữ"
              value={gender}
              onChange={async (e) => {
                const g = e.target.value;
                const d = await postJSON("/api/voices/update", { slug: v.slug, gender: g });
                if (!d.ok) return toast(d.error || "Không lưu được", "error");
                setGender(g);
              }}
            >
              <Options list={[["", "Chưa rõ"], ["male", "Nam"], ["female", "Nữ"]]} />
            </select>
            <PlayButton quiet label="Mẫu gốc" url={() => `/api/voices/sample?slug=${encodeURIComponent(v.slug || "")}&v=${encodeURIComponent(v.created_at || "")}`} />
          </>
        )}
        <PlayButton label="Nghe thử" url={() => `/api/voices/preview?voice=${encodeURIComponent(v.id)}&text=${encodeURIComponent(text.trim() || DEFAULT_PREVIEW_TEXT)}`} />
        {v.kind === "clone" && (
          <button className="icon-btn danger" type="button" title="Xóa giọng" aria-label={`Xóa giọng ${v.name}`} onClick={remove}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

type Src = "upload" | "url" | "video";

function CloneVoiceModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { sources, reload } = useStudio();
  const videos = sources.map((s) => [s.rel_path, s.name] as [string, string]);
  const [src, setSrc] = useState<Src>("upload");
  const [f, setF] = useState({ name: "", url: "", video: videos[0]?.[0] || "", mode: "auto", start: "", end: "" });
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState(""); // "", "upload", "work"
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function run() {
    const name = f.name.trim();
    if (!name) return toast("Hãy đặt tên cho giọng", "error");
    const body: Record<string, unknown> = { name };
    if (f.mode === "manual") {
      const start = Number(f.start);
      const end = Number(f.end);
      if (!(end - start >= 3 && end - start <= 8.5)) return toast("Đoạn mẫu phải dài từ 3 đến 8,5 giây", "error");
      Object.assign(body, { start, end });
    }
    if (src === "upload" && !file) return toast("Hãy chọn một file âm thanh hoặc video", "error");
    if (src === "url" && !/^https?:\/\/\S+$/i.test(f.url.trim())) return toast("Link phải bắt đầu bằng http", "error");
    try {
      if (src === "upload" && file) {
        setStep("upload");
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const up = await uploadFile<{ token: string }>(`/api/voices/upload?ext=${encodeURIComponent(ext)}`, file);
        if (!up.ok) throw new Error(up.error || "Không tải được file lên");
        Object.assign(body, { upload: up.token, upload_name: file.name });
      } else if (src === "url") body.url = f.url.trim();
      else body.rel_path = f.video;
      setStep("work");
      const d = await postJSON<{ voice: Voice }>("/api/voices/create", body);
      if (!d.ok) throw new Error(d.error || "Không tạo được giọng");
      toast(`Đã tạo giọng "${d.voice.name}" từ đoạn ${fmtDur(d.voice.start) || "0:00"}–${fmtDur(d.voice.end)}`, "success");
      onClose();
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
      setStep("");
    }
  }

  return (
    <Modal title="Clone giọng mới" onClose={onClose}>
      <Callout tone="info" icon="info">
        Cần một đoạn <b>5–8 giây, chỉ một người nói, ít nhạc nền</b>. Chỉ clone giọng của chính bạn hoặc giọng bạn được phép dùng.
      </Callout>
      <div className="field">
        <label htmlFor="cv-name">Tên giọng</label>
        <input id="cv-name" className="input" maxLength={60} autoFocus value={f.name} onChange={set("name")} placeholder="Ví dụ: Giọng kênh chính" />
      </div>
      <div className="field">
        <span className="label">Lấy giọng từ</span>
        <Seg<Src>
          value={src}
          onChange={setSrc}
          items={[
            { v: "upload", label: "Tải file lên" },
            { v: "url", label: "Dán link video" },
            { v: "video", label: "Video đã tải", disabled: !videos.length },
          ]}
        />
      </div>
      {src === "upload" && (
        <div className="field">
          <input className="input" type="file" accept="audio/*,video/*,.mkv,.flac,.opus" aria-label="File âm thanh hoặc video"
            onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <div className="help">mp3, wav, m4a, mp4... tối đa 500 MB.</div>
        </div>
      )}
      {src === "url" && (
        <div className="field">
          <input className="input" type="url" value={f.url} onChange={set("url")} placeholder="https://www.youtube.com/watch?v=..." aria-label="Link video" />
          <div className="help">YouTube, Bilibili... Máy chỉ tải phần tiếng.</div>
        </div>
      )}
      {src === "video" && (
        <div className="field">
          <select className="select" aria-label="Video đã tải" value={f.video} onChange={set("video")}>
            <Options list={videos} />
          </select>
        </div>
      )}
      <div className="form-grid cols-3">
        <div className="field">
          <label htmlFor="cv-mode">Đoạn giọng mẫu</label>
          <select id="cv-mode" className="select" value={f.mode} onChange={set("mode")}>
            <option value="auto">Máy tự chọn đoạn nói sạch nhất</option>
            <option value="manual">Tự nhập mốc thời gian</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cv-start">Từ giây</label>
          <input id="cv-start" className="input" type="number" min={0} step={0.1} disabled={f.mode !== "manual"} value={f.start} onChange={set("start")} />
        </div>
        <div className="field">
          <label htmlFor="cv-end">Đến giây</label>
          <input id="cv-end" className="input" type="number" min={0} step={0.1} disabled={f.mode !== "manual"} value={f.end} onChange={set("end")} />
        </div>
      </div>
      <div className="help" style={{ marginTop: -8, marginBottom: 16 }}>
        Tự nhập: đoạn dài 3–8,5 giây. Máy tự chọn: nghe 15 phút đầu, lấy đoạn nói liền mạch gần tông giọng chủ đạo nhất.
      </div>
      <div className="modal-foot">
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" type="button" disabled={!!step} onClick={run}>
          <Icon name={step ? "clock" : "mic"} size={16} /> {step === "upload" ? "Đang tải file lên…" : step === "work" ? "Đang xử lý…" : "Tạo giọng"}
        </button>
      </div>
    </Modal>
  );
}

export function VoiceLibrary() {
  const { voices } = useStudio();
  const [text, setText] = useState(DEFAULT_PREVIEW_TEXT);
  const [cloning, setCloning] = useState(false);
  return (
    <>
      <Callout tone="info" icon="mic">
        Giọng ở đây dùng chung cho <b>mọi dự án</b>. Chọn giọng khi lồng tiếng; giọng riêng của từng nhân vật đặt trong <b>Ngữ cảnh AI → Nhân vật</b> của dự án.
      </Callout>
      <div className="toolbar">
        <input className="input" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} aria-label="Câu dùng để nghe thử" placeholder="Câu dùng để nghe thử..." />
        <button className="btn btn-primary" type="button" onClick={() => setCloning(true)}>
          <Icon name="plus" size={16} /> Clone giọng mới
        </button>
      </div>
      <section className="card">
        <header className="card-head">
          <h3>
            Giọng clone của bạn <span className="badge gray">{voices.clones.length}</span>
          </h3>
        </header>
        {voices.clones.length ? (
          voices.clones.map((v) => <VoiceRow key={v.id} v={v} text={text} />)
        ) : (
          <div className="voice-empty muted">
            Chưa có giọng clone nào. Bấm <b>Clone giọng mới</b> để tạo giọng riêng từ một đoạn nói 5–8 giây.
          </div>
        )}
      </section>
      <section className="card">
        <header className="card-head">
          <h3>
            Giọng có sẵn <span className="badge gray">{voices.presets.length}</span>
          </h3>
          <span className="hint">VieNeu · chạy trên máy, không cần mạng</span>
        </header>
        {voices.presets.map((v) => (
          <VoiceRow key={v.id} v={v} text={text} />
        ))}
      </section>
      {cloning && <CloneVoiceModal onClose={() => setCloning(false)} />}
    </>
  );
}
