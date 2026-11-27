"use client";
/**
 * Chi tiết một bản lồng tiếng — bố cục studio (kiểu CapCut): video lớn ở giữa, panel chỉnh sửa bên phải
 * (3 tab: lời thoại, giọng đọc, hình & phụ đề), timeline cắt/ghép trải hết chiều ngang ở dưới,
 * một nút "Lưu & chạy lại" chung cho tất cả. Cả màn vừa khít chiều cao cửa sổ, không có khoảng trống thừa.
 * Server tự chọn mức làm lại nhỏ nhất (chỉ hình / chỉ tiếng) theo những gì thực sự đổi.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ProjectTopbar } from "@/components/ProjectTopbar";
import { RegionToggle } from "@/components/RegionPicker";
import { useToast } from "@/components/Toasts";
import { Options } from "@/components/ui";
import { DubScript } from "@/components/video/DubScript";
import { TimelineEditor } from "@/components/video/TimelineEditor";
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
  timeline_dirty?: boolean;
};

type Tab = "script" | "voice" | "video";

const BG_OPTIONS: [string, string][] = [["0", "Tắt hẳn"], ["0.05", "5% — rất nhỏ"], ["0.12", "12% — rõ tiếng động nền"]];
const nz = (s?: string) => s || "none";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);


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
  const [edits, setEdits] = useState<Record<string, string>>({}); // {id: lời mới}
  const [spk, setSpk] = useState<Record<string, string>>({}); // {id: nhân vật mới}
  const [structural, setStructural] = useState(false); // đã cắt/ghép/xóa/dời giờ câu, chưa xuất lại
  const [tab, setTab] = useState<Tab>("script");
  const [tableKey, setTableKey] = useState(0);
  const [stamp, setStamp] = useState(0); // đổi để tải lại sau khi xuất lại xong / hoàn tác
  const video = useRef<HTMLVideoElement>(null);
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);

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
      setEdits({});
      setSpk({});
      setStructural(Boolean(r.timeline_dirty));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, stamp]);

  // Xuất lại xong (cache_mb / updated đổi) thì nạp lại giá trị đã lưu và làm mới video đang phát.
  const doneKey = `${d?.updated_at || ""}`;
  useEffect(() => setStamp((s) => s + 1), [doneKey]);

  const editCount = new Set([...Object.keys(edits), ...Object.keys(spk)]).size;
  // Còn bản sửa chưa xuất lại mà rời trang thì hỏi lại.
  useEffect(() => {
    if (!editCount) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editCount]);

  if (!jobId) return <main className="content"><p className="muted">Thiếu mã bản lồng tiếng.</p></main>;
  if (!info) return <main className="content"><p className="muted">Đang tải...</p></main>;

  const proj = projects.find((p) => p.id === (info.project_id || pid));
  const speakers = Object.entries(info.multi_voice ? info.speakers || {} : {});

  // Dự án dùng 1 giọng chung cho mọi nhân vật — nút này áp giọng đó cho các nhân vật (cũ) đang khác giọng.
  const projVoice = proj?.voice || "";
  const ctxList = speakers.map(([k]) => [k, projVoice] as const).filter(([k, v]) => v && v !== (spkVoices[k] || info.speakers![k].voice));
  const ctxVoices = ctxList.length ? Object.fromEntries(ctxList) : null;

  const settingsVideoDirty =
    sub !== (info.burn_sub !== false) || nz(delogo) !== nz(info.delogo) || nz(subcover) !== nz(info.subcover) || !same(sub ? subStyle : null, info.burn_sub === false ? null : info.sub_style);
  const settingsAudioDirty =
    voice !== info.voice || Number(bg) !== Number(info.bg_volume ?? 0.05) || Object.entries(spkVoices).some(([k, v]) => v !== info.speakers?.[k]?.voice);
  const textEdits = Object.keys(edits).length > 0;
  const videoDirty = settingsVideoDirty || (textEdits && sub);
  const audioDirty = settingsAudioDirty || editCount > 0;
  const plan = structural ? "full" : videoDirty && audioDirty ? "both" : videoDirty ? "video" : audioDirty ? "audio" : "";
  const PLAN_TEXT = {
    full: "Timeline đã đổi (cắt/ghép/xóa/dời câu) — làm lại cả hình và tiếng theo mốc mới.",
    video: "Chỉ mã hóa lại hình — giữ nguyên tiếng đã xuất, không tạo lại giọng đọc.",
    audio: "Chỉ dựng lại tiếng — giữ nguyên hình đã xuất, không mã hóa lại video.",
    both: "Làm lại cả hình và tiếng — chỉ đọc lại câu đã sửa, phần không đổi dùng lại từ cache.",
  } as const;
  const summary = [
    editCount ? `sửa ${editCount} câu` : "",
    structural ? "đổi timeline" : "",
    settingsAudioDirty ? "đổi giọng/âm thanh" : "",
    settingsVideoDirty ? "đổi hình/phụ đề" : "",
  ].filter(Boolean);

  const onStructuralChange = (removedIds: number[], patch: Record<string, string> = {}) => {
    const drop = new Set(removedIds.map(String));
    setEdits((m) => ({ ...Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k))), ...patch }));
    setSpk((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k))));
    setStructural(true);
    setTableKey((k) => k + 1);
  };

  async function save() {
    if (!delogo) return toast("Hãy kéo chuột trên khung hình để khoanh vùng logo", "error");
    if (!subcover) return toast("Hãy kéo chuột trên khung hình để khoanh vùng phụ đề gốc", "error");
    const body: Record<string, unknown> = { job_id: jobId };
    if (textEdits) body.edits = edits;
    if (Object.keys(spk).length) body.speaker_edits = spk;
    if (settingsVideoDirty) Object.assign(body, { delogo, subcover, sub_style: sub ? subStyle : null, burn_sub: sub });
    if (settingsAudioDirty) {
      Object.assign(body, { voice, bg_volume: Number(bg) });
      const sv = Object.fromEntries(Object.entries(spkVoices).filter(([k, v]) => v !== info!.speakers?.[k]?.voice));
      if (Object.keys(sv).length) body.speaker_voices = sv;
    }
    const ok = await startTask("/api/dub/rerender", body, plan === "video" ? "Đang mã hóa lại hình" : plan === "audio" ? "Đang dựng lại tiếng" : "Đang xuất lại");
    if (!ok) return;
    // Server đã ghi lời/nhân vật vào DB: bỏ dấu "chưa lưu" và nạp lại bảng từ server.
    setEdits({});
    setSpk({});
    setTableKey((k) => k + 1);
  }

  const meta = [info.resolution, d?.duration_sec ? fmtDur(d.duration_sec) : "", d?.size_mb ? fmtSize(d.size_mb) : "", info.speed ? `${info.speed}x` : "", `${info.total.toLocaleString("vi")} câu`, d?.agy_model || ""].filter(Boolean);

  return (
    <>
      <ProjectTopbar title={info.title} sub={meta.join(" · ")} />
      <main className="studio">
        <section className="studio-stage" aria-label="Xem trước">
          <div className="stage-bar">
            <Link className="back-link" href={projHref(pid, "videos")}>‹ Video &amp; Lồng tiếng</Link>
            <span className="grow" />
            {d?.cache_mb ? <span className="stage-chip" title="Cache giúp xuất lại nhanh">Cache {fmtSize(d.cache_mb)}</span> : null}
            {d?.mp4_file && <a className="btn btn-quiet btn-sm" href={dubFileUrl(d.mp4_file)} download><Icon name="download" size={14} /> MP4</a>}
            {d?.srt_file && <a className="btn btn-quiet btn-sm" href={dubFileUrl(d.srt_file)} download><Icon name="cc" size={14} /> SRT</a>}
          </div>
          <video ref={video} key={stamp} className="stage-video" controls preload="metadata" src={dubFileUrl(`${jobId}.mp4`) + `?v=${stamp}`} />
        </section>

        <aside className="studio-panel" aria-label="Chỉnh sửa">
          <div className="seg studio-tabs" role="tablist" aria-label="Phần cần sửa">
            {([
              ["script", "edit", "Lời thoại", editCount || structural],
              ["voice", "mic", "Giọng đọc", settingsAudioDirty],
              ["video", "cc", "Hình & phụ đề", settingsVideoDirty],
            ] as const).map(([k, icon, label, dirty]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                <Icon name={icon} size={15} /> {label}
                {dirty ? <span className="tab-dot" title="Có thay đổi chưa lưu" /> : null}
              </button>
            ))}
          </div>

          <div className="panel-pane script-pane" hidden={tab !== "script"}>
            <div className="sel-host" ref={setDetailHost} />
            <DubScript
              jobId={jobId}
              video={video}
              speakers={speakers}
              edits={edits}
              setEdits={setEdits}
              spk={spk}
              setSpk={setSpk}
              reloadKey={tableKey}
              resetKey={stamp}
            />
          </div>

          <div className="panel-pane" hidden={tab !== "voice"}>
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
                <div className="help">Giọng đổi ở đây chỉ áp dụng cho video này. Giọng chung của dự án đặt trong Ngữ cảnh AI → Thông tin.</div>
              </div>
            )}
            <div className="field">
              <label htmlFor="dt-bg">Âm thanh gốc làm nền</label>
              <select id="dt-bg" className="select" value={bg} onChange={(e) => setBg(e.target.value)}>
                <Options list={BG_OPTIONS.some(([v]) => Number(v) === Number(bg)) ? BG_OPTIONS : [...BG_OPTIONS, [bg, `${Math.round(Number(bg) * 100)}%`]]} />
              </select>
            </div>
          </div>

          <div className="panel-pane" hidden={tab !== "video"}>
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
        </aside>

        <section className="studio-timeline" aria-label="Timeline">
          <TimelineEditor
            key={stamp}
            jobId={jobId}
            video={video}
            speakers={speakers}
            edits={edits}
            setEdits={setEdits}
            spk={spk}
            setSpk={setSpk}
            onStructuralChange={onStructuralChange}
            detailHost={detailHost}
            onSelect={() => setTab("script")}
          />
        </section>
      </main>

      <div className="detail-bar">
        <span className="detail-bar-text">
          {running ? "Đang chạy lại..." : plan ? <><b>Đã {summary.join(", ") || "đổi"}:</b> {PLAN_TEXT[plan]}</> : "Chưa có thay đổi nào."}
        </span>
        <span className="grow" />
        <button className="btn btn-light" type="button" disabled={!(summary.length - (structural ? 1 : 0)) || running} onClick={() => setStamp((s) => s + 1)}
          title="Bỏ các thay đổi chưa lưu (cắt/ghép/xóa câu đã áp dụng ngay, không hoàn tác được)">
          Hoàn tác
        </button>
        <button className="btn btn-primary" type="button" disabled={!plan || running} onClick={save}>
          <Icon name="play" size={15} /> Lưu &amp; chạy lại
        </button>
      </div>

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
