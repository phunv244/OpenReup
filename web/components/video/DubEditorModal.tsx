"use client";
/** Sửa lời dịch: phân trang phía server nên video 90 tiếng (>100k câu) vẫn mở tức thì. */
import { useEffect, useRef, useState } from "react";
import { Speaker, SubStyle, dubFileUrl, getJSON } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { voiceOptions } from "@/lib/voices";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { RegionToggle } from "../RegionPicker";
import { useToast } from "../Toasts";
import { Options } from "../ui";
import { SubtitleStudio } from "./SubtitleStudio";

type Segment = { id: number; start: number; end: number; zh: string; vi: string; speaker: string };
type Page = {
  ok?: boolean;
  error?: string;
  title: string;
  voice: string;
  delogo?: string;
  subcover?: string;
  sub_style?: SubStyle | null;
  burn_sub?: boolean;
  input_path?: string;
  project_id?: string;
  multi_voice?: boolean;
  speakers?: Record<string, Speaker>;
  total: number;
  empty: number;
  matched: number;
  offset: number;
  items: Segment[];
};

const LIMIT = 100;
const spkIndex = (k: string) => Number(String(k).replace(/\D/g, "")) || 1;

export function DubEditorModal({ jobId, projectId, onClose }: { jobId: string; projectId: string; onClose: () => void }) {
  const toast = useToast();
  const { projects, voices, startTask } = useStudio();
  const allVoices = [...voices.clones, ...voices.presets];
  const [info, setInfo] = useState<Page | null>(null); // thông tin cố định (lần tải đầu)
  const [page, setPage] = useState<Page | null>(null);
  const [q, setQ] = useState({ offset: 0, text: "", only: "" });
  const [edits, setEdits] = useState<Record<string, string>>({}); // {id: lời mới}
  const [spk, setSpk] = useState<Record<string, string>>({}); // {id: nhân vật mới}
  const [spkVoices, setSpkVoices] = useState<Record<string, string>>({}); // {nhân vật: giọng mới}
  const [voice, setVoice] = useState("");
  const [sub, setSub] = useState(true);
  const [delogo, setDelogo] = useState("none");
  const [subcover, setSubcover] = useState("none");
  const [subStyle, setSubStyle] = useState<SubStyle | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const first = useRef(false);
  // Trang cha vẽ lại mỗi 2,5 giây (hỏi tiến trình): giữ hàm trong ref để không tải lại câu thoại mỗi lần.
  const stable = useRef({ onClose, toast });
  stable.current = { onClose, toast };

  // Gõ tìm: chờ 250 ms rồi mới gọi server; bỏ kết quả của yêu cầu cũ hơn.
  useEffect(() => {
    const seq = ++loadSeq.current;
    const t = setTimeout(async () => {
      const params = new URLSearchParams({ id: jobId, offset: String(q.offset), limit: String(LIMIT), q: q.text, only: q.only });
      const d = await getJSON<Page>("/api/dub/segments?" + params);
      if (seq !== loadSeq.current) return;
      if (d.error) {
        stable.current.toast(d.error, "error");
        return stable.current.onClose();
      }
      if (!first.current) {
        // Lần đầu: điền thông tin cố định của bản lồng tiếng
        first.current = true;
        setInfo(d);
        setVoice(d.voice);
        setSub(d.burn_sub !== false);
        setSubStyle(d.sub_style || null);
      }
      setPage(d);
      if (table.current) table.current.scrollTop = 0;
    }, q.text ? 250 : 0);
    return () => clearTimeout(t);
  }, [jobId, q]);

  const editCount = new Set([...Object.keys(edits), ...Object.keys(spk)]).size;
  const changes = editCount + Object.keys(spkVoices).length;
  const close = () => (!changes || confirm("Bạn có thay đổi chưa xuất lại. Đóng và bỏ các thay đổi?")) && onClose();

  const proj = projects.find((p) => p.id === info?.project_id) || projects.find((p) => p.id === projectId);
  const speakers = Object.entries(info?.multi_voice ? info.speakers || {} : {});
  const spkKeys = speakers.map(([k]) => k);

  async function save() {
    if (!delogo) return toast("Hãy kéo chuột trên khung hình để khoanh vùng logo", "error");
    if (!subcover) return toast("Hãy kéo chuột trên khung hình để khoanh vùng phụ đề gốc", "error");
    const ok = await startTask(
      "/api/dub/rerender",
      { job_id: jobId, edits, speaker_edits: spk, speaker_voices: spkVoices, voice, delogo, subcover, sub_style: sub ? subStyle : null, burn_sub: sub },
      "Đang xuất lại — chỉ những câu và đoạn video bị sửa mới phải làm lại"
    );
    if (ok) onClose();
  }

  const setMap = (map: Record<string, string>, setter: (m: Record<string, string>) => void, key: string, val: string, orig: string) => {
    const next = { ...map };
    if (val !== orig) next[key] = val;
    else delete next[key];
    setter(next);
  };

  return (
    <Modal title={info ? `Sửa lời dịch · ${info.title}` : "Sửa lời dịch"} onClose={close} size="xl" sticky>
      <div className="editor">
        <div className="editor-side">
          <video ref={video} className="editor-video" controls preload="metadata" src={dubFileUrl(`${jobId}.mp4`)} />
          <div className="help">Bấm vào mốc giờ của một câu để nghe lại đúng đoạn đó.</div>
          {info && !speakers.length && (
            <div className="field">
              <label htmlFor="ed-voice">Giọng đọc</label>
              <select id="ed-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                <Options list={voiceOptions(allVoices, proj, info.voice)} />
              </select>
            </div>
          )}
          {speakers.length > 0 && (
            <div className="field">
              <span className="label">Giọng từng nhân vật</span>
              {speakers.map(([k, s]) => (
                <div className="spk-row" key={k}>
                  <span className={`spk-tag spk-${spkIndex(k)}`}>{k}</span>
                  <span className="muted spk-meta">
                    <b className="spk-name">{s.name || "Chưa rõ là ai"}</b>
                    {s.is_new && <span className="badge amber">Nhân vật mới</span>} · {s.lines || 0} câu · ~{s.f0 || "?"} Hz
                  </span>
                  <select
                    className="select input-sm"
                    aria-label={`Giọng của ${k}`}
                    value={spkVoices[k] || s.voice}
                    onChange={(e) => setMap(spkVoices, setSpkVoices, k, e.target.value, s.voice)}
                  >
                    <Options list={voiceOptions(allVoices, proj, s.voice)} />
                  </select>
                </div>
              ))}
              <div className="help">Đổi nhân vật của từng câu ở cột &quot;Nhân vật&quot; nếu máy tách nhầm.</div>
            </div>
          )}
          {info && <RegionToggle label="Xóa logo" rel={info.input_path || ""} initial={info.delogo} onChange={setDelogo} />}
          {info && (
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
          )}
        </div>
        <div className="editor-main">
          <div className="toolbar">
            <input
              className="input"
              type="search"
              placeholder="Tìm trong lời Việt hoặc tiếng Trung..."
              aria-label="Tìm câu thoại"
              onChange={(e) => setQ({ ...q, text: e.target.value, offset: 0 })}
            />
            <label className="check">
              <input type="checkbox" onChange={(e) => setQ({ ...q, only: e.target.checked ? "empty" : "", offset: 0 })} /> Chỉ câu chưa dịch{" "}
              <span className="cnt">{page?.empty ?? 0}</span>
            </label>
          </div>
          <div className="table-wrap bordered editor-table" ref={table}>
            <table className="tbl compact">
              <thead>
                <tr>
                  <th>Mốc giờ</th>
                  {spkKeys.length > 0 && <th className="spk-col">Nhân vật</th>}
                  <th>Tiếng Trung gốc</th>
                  <th>Lời Việt (sửa trực tiếp)</th>
                </tr>
              </thead>
              <tbody>
                {!page ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      Đang tải...
                    </td>
                  </tr>
                ) : page.items.length ? (
                  page.items.map((s) => {
                    const id = String(s.id);
                    const who = spk[id] || s.speaker || "NV1";
                    return (
                      <tr key={id} className={id in edits || id in spk ? "edited" : ""}>
                        <td>
                          <button
                            className="time-btn"
                            type="button"
                            title="Phát từ mốc này"
                            onClick={() => {
                              const el = video.current;
                              if (!el) return;
                              el.currentTime = s.start;
                              el.play();
                            }}
                          >
                            {fmtDur(s.start) || "0:00"}
                          </button>
                        </td>
                        {spkKeys.length > 0 && (
                          <td>
                            <select
                              className={`select input-sm seg-spk spk-${spkIndex(who)}`}
                              aria-label={`Nhân vật câu ${id}`}
                              value={who}
                              onChange={(e) => setMap(spk, setSpk, id, e.target.value, s.speaker || "NV1")}
                            >
                              <Options list={speakers.map(([k, s]) => [k, s.name ? `${k} · ${s.name}${s.is_new ? " (mới)" : ""}` : k])} />
                            </select>
                          </td>
                        )}
                        <td className="zh">{s.zh}</td>
                        <td>
                          <input
                            className="input input-sm seg-vi"
                            type="text"
                            aria-label={`Lời Việt câu ${id}`}
                            value={id in edits ? edits[id] : s.vi}
                            onChange={(e) => {
                              const next = { ...edits };
                              if (e.target.value.trim() !== s.vi) next[id] = e.target.value;
                              else delete next[id];
                              setEdits(next);
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4} className="muted">
                      Không có câu nào khớp.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="editor-pager">
            <button className="btn btn-light btn-sm" type="button" disabled={!page || page.offset <= 0}
              onClick={() => setQ({ ...q, offset: Math.max(0, q.offset - LIMIT) })}>
              ‹ Trước
            </button>
            <span className="muted">
              {page?.matched
                ? `${(page.offset + 1).toLocaleString("vi")}–${(page.offset + page.items.length).toLocaleString("vi")} / ${page.matched.toLocaleString("vi")} câu`
                : "0 câu"}
            </span>
            <button className="btn btn-light btn-sm" type="button" disabled={!page || page.offset + page.items.length >= page.matched}
              onClick={() => setQ({ ...q, offset: q.offset + LIMIT })}>
              Sau ›
            </button>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="muted">
          {[editCount ? `Đã sửa ${editCount} câu` : "", Object.keys(spkVoices).length ? `đổi giọng ${Object.keys(spkVoices).length} nhân vật` : ""]
            .filter(Boolean)
            .join(", ") || "Chưa sửa câu nào"}
        </span>
        <span className="grow" />
        <button className="btn btn-light" type="button" onClick={close}>
          Đóng
        </button>
        <button className="btn btn-primary" type="button" onClick={save}>
          <Icon name="mic" size={16} /> Lưu & xuất lại
        </button>
      </div>
    </Modal>
  );
}
