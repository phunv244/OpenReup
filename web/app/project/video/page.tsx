"use client";
/**
 * Chi tiết một bản lồng tiếng: gom mọi thứ sửa được theo công đoạn, mỗi nhóm ghi rõ chạy lại tốn gì.
 * Server tự chọn mức làm lại nhỏ nhất (chỉ hình / chỉ tiếng) theo những gì thực sự đổi.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ProjectTopbar } from "@/components/ProjectTopbar";
import { RegionToggle } from "@/components/RegionPicker";
import { useToast } from "@/components/Toasts";
import { Options } from "@/components/ui";
import { DubEditorModal } from "@/components/video/DubEditorModal";
import { SubtitleStudio } from "@/components/video/SubtitleStudio";
import { Speaker, SubStyle, dubFileUrl, getJSON } from "@/lib/api";
import { fmtDur, fmtSize, projHref } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";
import { voiceOptions } from "@/lib/voices";

type Info = {
  error?: string;
  title: string;
  voice: string;
  bg_volume?: number;
  delogo?: string;
  subcover?: string;
  sub_style?: SubStyle | null;
  burn_sub?: boolean;
  input_path?: string;
  project_id?: string;
  multi_voice?: boolean;
  speakers?: Record<string, Speaker>;
  speed?: number;
  resolution?: string;
  total: number;
  empty: number;
};

const BG_OPTIONS: [string, string][] = [["0", "Tắt hẳn"], ["0.05", "5% — rất nhỏ"], ["0.12", "12% — rõ tiếng động nền"]];
const nz = (s?: string) => s || "none";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function Cost({ tone, children }: { tone: "green" | "amber" | "gray"; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Detail() {
  const jobId = useSearchParams().get("job") || "";
  const pid = useProjectId();
  const toast = useToast();
  const { projects, voices, dubbed, task, startTask } = useStudio();
  const allVoices = [...voices.clones, ...voices.presets];
  const [info, setInfo] = useState<Info | null>(null);
  const [voice, setVoice] = useState("");
  const [spkVoices, setSpkVoices] = useState<Record<string, string>>({});
  const [bg, setBg] = useState("0.05");
  const [sub, setSub] = useState(true);
  const [delogo, setDelogo] = useState("none");
  const [subcover, setSubcover] = useState("none");
  const [subStyle, setSubStyle] = useState<SubStyle | null>(null);
  const [editing, setEditing] = useState(false);
  const [stamp, setStamp] = useState(0); // đổi để tải lại sau khi xuất lại xong

  const d = dubbed.find((x) => x.job_id === jobId);
  const running = Boolean(task?.running && task.target === jobId);

  useEffect(() => {
    if (!jobId) return;
    getJSON<Info>(`/api/dub/segments?id=${encodeURIComponent(jobId)}&limit=1`).then((r) => {
      if (r.error) return toast(r.error, "error");
      setInfo(r);
      setVoice(r.voice);
      setBg(String(r.bg_volume ?? 0.05));
      setSub(r.burn_sub !== false);
      setSubStyle(r.sub_style || null);
      setSpkVoices({});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, stamp]);

  // Xuất lại xong (cache_mb / updated đổi) thì nạp lại giá trị đã lưu và làm mới video đang phát.
  const doneKey = `${d?.updated_at || ""}`;
  useEffect(() => setStamp((s) => s + 1), [doneKey]);

  if (!jobId) return <main className="content"><p className="muted">Thiếu mã bản lồng tiếng.</p></main>;
  if (!info) return <main className="content"><p className="muted">Đang tải...</p></main>;

  const proj = projects.find((p) => p.id === (info.project_id || pid));
  const speakers = Object.entries(info.multi_voice ? info.speakers || {} : {});

  // Giọng đang cấu hình trong ngữ cảnh dự án cho các nhân vật có mặt ở video này (khác giọng hiện tại thì mới hiện nút).
  const byZh = new Map((proj?.characters || []).map((c) => [c.zh, c.voice || ""]));
  const ctxList = speakers.map(([k, s]) => [k, byZh.get(s.zh || "") || ""] as const).filter(([k, v]) => v && v !== (spkVoices[k] || info.speakers![k].voice));
  const ctxVoices = ctxList.length ? Object.fromEntries(ctxList) : null;

  const videoDirty =
    sub !== (info.burn_sub !== false) || nz(delogo) !== nz(info.delogo) || nz(subcover) !== nz(info.subcover) || !same(sub ? subStyle : null, info.burn_sub === false ? null : info.sub_style);
  const audioDirty =
    voice !== info.voice || Number(bg) !== Number(info.bg_volume ?? 0.05) || Object.entries(spkVoices).some(([k, v]) => v !== info.speakers?.[k]?.voice);
  const plan = videoDirty && audioDirty ? "both" : videoDirty ? "video" : audioDirty ? "audio" : "";
  const PLAN_TEXT = {
    video: "Chỉ mã hóa lại hình — giữ nguyên tiếng đã xuất, không tạo lại giọng đọc.",
    audio: "Chỉ dựng lại tiếng — giữ nguyên hình đã xuất, không mã hóa lại video.",
    both: "Làm lại cả hình và tiếng (giọng đọc và đoạn video không đổi vẫn dùng lại từ cache).",
  } as const;

  async function save() {
    if (!delogo) return toast("Hãy kéo chuột trên khung hình để khoanh vùng logo", "error");
    if (!subcover) return toast("Hãy kéo chuột trên khung hình để khoanh vùng phụ đề gốc", "error");
    const body: Record<string, unknown> = { job_id: jobId };
    if (videoDirty) Object.assign(body, { delogo, subcover, sub_style: sub ? subStyle : null, burn_sub: sub });
    if (audioDirty) {
      Object.assign(body, { voice, bg_volume: Number(bg) });
      const sv = Object.fromEntries(Object.entries(spkVoices).filter(([k, v]) => v !== info!.speakers?.[k]?.voice));
      if (Object.keys(sv).length) body.speaker_voices = sv;
    }
    await startTask("/api/dub/rerender", body, plan === "video" ? "Đang mã hóa lại hình" : plan === "audio" ? "Đang dựng lại tiếng" : "Đang xuất lại");
  }

  const meta = [info.resolution, d?.duration_sec ? fmtDur(d.duration_sec) : "", d?.size_mb ? fmtSize(d.size_mb) : "", info.speed ? `${info.speed}x` : "", `${info.total.toLocaleString("vi")} câu`].filter(Boolean);

  return (
    <>
      <ProjectTopbar title={info.title} sub="Chi tiết bản lồng tiếng — chỉnh từng phần rồi chạy lại đúng phần đó" />
      <main className="content dub-detail">
        <Link className="back-link" href={projHref(pid, "videos")}>
          ‹ Video &amp; Lồng tiếng
        </Link>
        <div className="detail-grid">
          <div className="detail-main">
            <section className="card">
              <div className="card-head">
                <h3><Icon name="cc" size={16} /> Hình &amp; phụ đề</h3>
                <Cost tone="amber">Chạy lại: mã hóa lại hình · giữ tiếng</Cost>
              </div>
              <div className="card-body">
                <RegionToggle label="Xóa logo" rel={info.input_path || ""} initial={info.delogo} onChange={setDelogo} />
                <SubtitleStudio
                  rel={info.input_path || ""}
                  burn={sub}
                  onBurn={setSub}
                  subcover={subcover}
                  initialSubcover={info.subcover}
                  onSubcover={setSubcover}
                  style={subStyle}
                  onStyle={setSubStyle}
                />
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h3><Icon name="mic" size={16} /> Giọng đọc &amp; âm thanh</h3>
                <Cost tone="amber">Chạy lại: dựng lại tiếng · giữ hình</Cost>
              </div>
              <div className="card-body">
                {!speakers.length ? (
                  <div className="field">
                    <label htmlFor="dt-voice">Giọng đọc</label>
                    <select id="dt-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                      <Options list={voiceOptions(allVoices, proj, info.voice)} />
                    </select>
                  </div>
                ) : (
                  <div className="field">
                    <span className="label">Giọng từng nhân vật</span>
                    {speakers.map(([k, s]) => (
                      <div className="spk-row" key={k}>
                        <span className={`spk-tag spk-${Number(k.replace(/\D/g, "")) || 1}`}>{k}</span>
                        <span className="muted spk-meta">
                          <b className="spk-name">{s.name || "Chưa rõ là ai"}</b>
                          {s.is_new && <span className="badge amber">Nhân vật mới</span>} · {s.lines || 0} câu · ~{s.f0 || "?"} Hz
                        </span>
                        <select className="select input-sm" aria-label={`Giọng của ${k}`} value={spkVoices[k] || s.voice}
                          onChange={(e) => setSpkVoices({ ...spkVoices, [k]: e.target.value })}>
                          <Options list={voiceOptions(allVoices, proj, s.voice)} />
                        </select>
                      </div>
                    ))}
                    {ctxVoices && (
                      <button className="btn btn-light btn-sm" type="button" onClick={() => setSpkVoices({ ...spkVoices, ...ctxVoices })}>
                        <Icon name="brain" size={14} /> Lấy giọng theo Ngữ cảnh AI
                      </button>
                    )}
                    <div className="help">Giọng đổi ở đây chỉ áp dụng cho video này. Giọng mặc định của từng nhân vật đặt trong Ngữ cảnh AI → Nhân vật.</div>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="dt-bg">Âm thanh gốc làm nền</label>
                  <select id="dt-bg" className="select" value={bg} onChange={(e) => setBg(e.target.value)}>
                    <Options list={BG_OPTIONS.some(([v]) => Number(v) === Number(bg)) ? BG_OPTIONS : [...BG_OPTIONS, [bg, `${Math.round(Number(bg) * 100)}%`]]} />
                  </select>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h3><Icon name="edit" size={16} /> Lời thoại</h3>
                <Cost tone="gray">Chạy lại: chỉ câu và đoạn video bị sửa</Cost>
              </div>
              <div className="card-body">
                <p className="help">
                  {info.total.toLocaleString("vi")} câu{info.empty ? `, ${info.empty} câu chưa dịch` : ""}. Sửa lời xong sẽ xuất lại ngay: chỉ đọc lại những câu đã sửa
                  và mã hóa lại đúng các đoạn 10 phút có câu đó.
                </p>
                <button className="btn btn-light" type="button" onClick={() => setEditing(true)} disabled={running}>
                  <Icon name="edit" size={15} /> Mở trình sửa lời
                </button>
              </div>
            </section>
          </div>

          <aside className="detail-side">
            <video key={stamp} className="editor-video" controls preload="metadata" src={dubFileUrl(`${jobId}.mp4`) + `?v=${stamp}`} />
            <div className="detail-meta">{meta.join(" · ")}</div>
            <dl className="detail-facts">
              {d?.agy_model ? (<><dt>Model dịch</dt><dd>{d.agy_model}</dd></>) : null}
              {d?.cache_mb ? (<><dt>Cache</dt><dd>{fmtSize(d.cache_mb)} — giúp xuất lại nhanh</dd></>) : null}
            </dl>
            <div className="detail-links">
              {d?.mp4_file && <a className="btn btn-light btn-sm" href={dubFileUrl(d.mp4_file)} download><Icon name="download" size={14} /> MP4</a>}
              {d?.srt_file && <a className="btn btn-light btn-sm" href={dubFileUrl(d.srt_file)} download><Icon name="cc" size={14} /> SRT</a>}
            </div>
          </aside>
        </div>
      </main>

      <div className="detail-bar">
        <span className="detail-bar-text">
          {running ? "Đang chạy lại..." : plan ? <><b>Đã đổi:</b> {PLAN_TEXT[plan]}</> : "Chưa có thay đổi nào."}
        </span>
        <span className="grow" />
        <button className="btn btn-light" type="button" disabled={!plan || running} onClick={() => setStamp((s) => s + 1)}>
          Hoàn tác
        </button>
        <button className="btn btn-primary" type="button" disabled={!plan || running} onClick={save}>
          <Icon name="play" size={15} /> Lưu &amp; chạy lại
        </button>
      </div>

      {editing && <DubEditorModal jobId={jobId} projectId={pid} onClose={() => setEditing(false)} />}
    </>
  );
}

export default function VideoDetailPage() {
  return (
    <Suspense fallback={null}>
      <Detail />
    </Suspense>
  );
}
