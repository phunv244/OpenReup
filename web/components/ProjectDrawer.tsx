"use client";
/** Ngăn trượt: ngữ cảnh AI & cài đặt dự án (thông tin, nhân vật, từ điển, mạch truyện). */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Character, GlossItem, Project, postJSON } from "@/lib/api";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";
import { voiceOptions } from "@/lib/voices";
import { Callout, Options, copyText } from "./ui";

const TYPES = ["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"];
type Tab = "info" | "chars" | "gloss" | "notes";

export function buildAiContextPrompt(proj: Project) {
  const chars = (proj.characters || []).map((c) => `- ${c.zh} → ${c.vi} (${c.role || ""}; xưng hô: ${c.pronouns || ""}${c.personality ? `; tính cách: ${c.personality}` : ""})`).join("\n");
  const gloss = (proj.glossary || []).map((g) => `- ${g.zh} → ${g.vi}`).join("\n");
  const eps = (proj.videos || [])
    .map((v, i) => `- Tập ${i + 1} (${v.title}): ${(proj.episode_notes || {})[v.job_id] || "(chưa có tóm tắt)"}`)
    .join("\n");
  return [
    `=== NGỮ CẢNH DỰ ÁN: ${proj.name} (${proj.type}) ===`,
    `Phong cách dịch: ${proj.style || ""}`,
    `Cốt truyện chung: ${proj.synopsis || ""}`,
    "",
    "Nhân vật & Xưng hô:",
    chars || "(chưa có)",
    "",
    "Từ điển thuật ngữ:",
    gloss || "(chưa có)",
    "",
    "Mạch truyện các video trước trong dự án:",
    eps || "(chưa có)",
    "",
    "Yêu cầu: Dựa vào ngữ cảnh trên, hãy sửa lỗi nghe nhầm của Whisper và dịch lời thoại tập tiếp theo thật tự nhiên, đúng xưng hô và giữ liền mạch cốt truyện.",
  ].join("\n");
}

/** Bảng sửa nhanh dùng chung cho Nhân vật và Từ điển. */
function RowsTable<T extends Record<string, string | undefined>>({
  rows, setRows, cols, hint, emptyText, blank,
}: {
  rows: T[];
  setRows: (r: T[]) => void;
  cols: [keyof T & string, string, [string, string][]?][]; // có danh sách lựa chọn thì hiện ô chọn thay ô nhập
  hint: string;
  emptyText: string;
  blank: T;
}) {
  return (
    <>
      <div className="drawer-bar">
        <span className="muted">{hint}</span>
        <button className="btn btn-light btn-sm" type="button" onClick={() => setRows([...rows, { ...blank }])}>
          <Icon name="plus" size={14} /> Thêm
        </button>
      </div>
      <div className="table-wrap bordered">
        <table className="tbl compact">
          <thead>
            <tr>
              {cols.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r, i) => (
                <tr key={i}>
                  {cols.map(([key, label, options], ci) => (
                    <td key={key}>
                      {options ? (
                        <select className="select input-sm" value={r[key] || ""} aria-label={label}
                          onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)))}>
                          <Options list={options} />
                        </select>
                      ) : (
                      <input
                        className="input input-sm"
                        value={r[key] || ""}
                        aria-label={label}
                        autoFocus={ci === 0 && i === rows.length - 1 && !r[key]}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)))}
                      />
                      )}
                    </td>
                  ))}
                  <td>
                    <button className="icon-btn danger" type="button" title="Xóa dòng" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <Icon name="x" size={15} />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="muted">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ProjectDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const { reload, voices } = useStudio();
  const allVoices = [...voices.clones, ...voices.presets];
  const [tab, setTab] = useState<Tab>("info");
  const [d, setD] = useState({
    name: project.name || "",
    type: project.type || TYPES[0],
    style: project.style || "",
    synopsis: project.synopsis || "",
    characters: (project.characters || []).map((c) => ({ ...c })) as Character[],
    glossary: (project.glossary || []).map((g) => ({ ...g })) as GlossItem[],
    episode_notes: { ...(project.episode_notes || {}) } as Record<string, string>,
  });
  const videos = project.videos || [];
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    const r = await postJSON("/api/projects/save", {
      id: project.id,
      name: d.name.trim(),
      type: d.type,
      style: d.style.trim(),
      synopsis: d.synopsis.trim(),
      characters: d.characters.map((c) => ({ ...c, zh: c.zh.trim(), vi: c.vi.trim(), pronouns: (c.pronouns || "").trim(), personality: (c.personality || "").trim() })).filter((c) => c.zh || c.vi),
      glossary: d.glossary.map(({ zh, vi }) => ({ zh: zh.trim(), vi: vi.trim() })).filter((g) => g.zh || g.vi),
      episode_notes: Object.fromEntries(Object.entries(d.episode_notes).map(([k, v]) => [k, v.trim()])),
    });
    if (!r.ok) return toast(r.error || "Lưu thất bại", "error");
    toast("Đã lưu ngữ cảnh dự án", "success");
    onClose();
    reload();
  }

  async function remove() {
    if (!confirm(`Xóa dự án "${d.name}"?\n\nCác file video vẫn được giữ nguyên, chỉ mất ngữ cảnh AI của dự án.`)) return;
    await postJSON("/api/projects/delete", { id: project.id });
    toast("Đã xóa dự án", "success");
    onClose();
    await reload();
    router.push("/");
  }

  const tabs: [Tab, string, number?][] = [
    ["info", "Thông tin"],
    ["chars", "Nhân vật", d.characters.length],
    ["gloss", "Từ điển", d.glossary.length],
    ["notes", "Mạch truyện", videos.length],
  ];

  return createPortal(
    <div className="drawer-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Ngữ cảnh AI của dự án">
        <div className="drawer-head">
          <h3>Ngữ cảnh AI · {d.name}</h3>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Đóng">
            <Icon name="x" />
          </button>
        </div>
        <div className="tabs">
          {tabs.map(([k, label, n]) => (
            <button key={k} type="button" className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {label} {n != null && <span className="cnt">{n}</span>}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {tab === "info" && (
            <>
              <div className="field">
                <label htmlFor="dr-name">Tên dự án</label>
                <input id="dr-name" className="input" value={d.name} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="dr-type">Thể loại</label>
                <select id="dr-type" className="select" value={d.type} onChange={(e) => set("type", e.target.value)}>
                  {[...new Set([...TYPES, d.type])].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="dr-style">Phong cách dịch & giọng văn</label>
                <input id="dr-style" className="input" value={d.style} onChange={(e) => set("style", e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="dr-syn">Cốt truyện chung</label>
                <textarea id="dr-syn" className="input" rows={6} value={d.synopsis} onChange={(e) => set("synopsis", e.target.value)} />
              </div>
              <Callout tone="info" icon="brain">
                Mỗi lần dịch, AI đọc toàn bộ ngữ cảnh này, rồi tự bổ sung nhân vật và thuật ngữ mới gặp vào dự án.
              </Callout>
            </>
          )}
          {tab === "chars" && (
            <RowsTable
              rows={d.characters}
              setRows={(r) => set("characters", r)}
              cols={[
                ["zh", "Tên gốc"], ["vi", "Tên Việt"], ["pronouns", "Xưng hô"], ["personality", "Tính cách"],
                ["voice", "Giọng đọc", [["", "Tự chọn"], ...voiceOptions(allVoices, project, "").filter(([id]) => id)]],
              ]}
              hint="AI tự thêm nhân vật, ghi tính cách qua lời thoại và chọn giọng khi lồng tiếng nhiều giọng — bạn sửa được tất cả."
              emptyText="Chưa có nhân vật."
              blank={{ zh: "", vi: "", pronouns: "", role: "", personality: "", voice: "" }}
            />
          )}
          {tab === "gloss" && (
            <RowsTable
              rows={d.glossary}
              setRows={(r) => set("glossary", r)}
              cols={[["zh", "Từ gốc"], ["vi", "Dịch tiếng Việt"]]}
              hint="Thuật ngữ, chiêu thức, từ lóng riêng của bộ này."
              emptyText="Chưa có thuật ngữ."
              blank={{ zh: "", vi: "" }}
            />
          )}
          {tab === "notes" &&
            (videos.length ? (
              videos.map((v, i) => (
                <div className="field" key={v.job_id}>
                  <label htmlFor={`ep-${i}`}>
                    {i + 1}. {v.title}
                  </label>
                  <textarea
                    id={`ep-${i}`}
                    className="input"
                    rows={3}
                    value={d.episode_notes[v.job_id] || ""}
                    onChange={(e) => set("episode_notes", { ...d.episode_notes, [v.job_id]: e.target.value })}
                  />
                </div>
              ))
            ) : (
              <p className="muted">
                Chưa có video nào được lồng tiếng trong dự án này. Sau mỗi video, AI tự ghi tóm tắt diễn biến ở đây để giữ mạch truyện cho video sau.
              </p>
            ))}
        </div>
        <div className="drawer-foot">
          <button className="btn btn-quiet btn-sm danger" type="button" onClick={remove}>
            <Icon name="trash" size={15} /> Xóa dự án
          </button>
          <span className="grow" />
          <button className="btn btn-light" type="button" onClick={() => copyText(buildAiContextPrompt({ ...project, ...d }), toast)}>
            <Icon name="copy" size={15} /> Copy ngữ cảnh
          </button>
          <button className="btn btn-primary" type="button" onClick={save}>
            Lưu
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
