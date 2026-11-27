"use client";
/**
 * Danh sách lời thoại của một bản lồng tiếng — nằm trong panel bên phải của studio (timeline ở dải dưới).
 * Tìm kiếm + phân trang phía server (video >100k câu vẫn mở tức thì).
 * Bản sửa lời/nhân vật (`edits`/`spk`) do trang cha giữ để gộp chung 1 lần "Lưu & chạy lại".
 */
import { useEffect, useRef, useState } from "react";
import { Speaker, getJSON } from "@/lib/api";
import { setMap } from "@/lib/editMap";
import { fmtDur } from "@/lib/format";
import { useToast } from "../Toasts";
import { Options } from "../ui";

type Segment = { id: number; start: number; end: number; zh: string; vi: string; speaker: string };
type Page = { error?: string; total: number; empty: number; matched: number; offset: number; items: Segment[] };

const LIMIT = 100;
const spkIndex = (k: string) => Number(String(k).replace(/\D/g, "")) || 1;

type Props = {
  jobId: string;
  video: React.RefObject<HTMLVideoElement | null>;
  speakers: [string, Speaker][];
  edits: Record<string, string>;
  setEdits: (m: Record<string, string>) => void;
  spk: Record<string, string>;
  setSpk: (m: Record<string, string>) => void;
  /** Đổi để nạp lại bảng (sau cắt/ghép/xóa). */
  reloadKey: number;
  /** Đổi để nạp lại sau khi xuất lại xong / hoàn tác. */
  resetKey: number;
};

export function DubScript({ jobId, video, speakers, edits, setEdits, spk, setSpk, reloadKey, resetKey }: Props) {
  const toast = useToast();
  const [page, setPage] = useState<Page | null>(null);
  const [q, setQ] = useState({ offset: 0, text: "", only: "" });
  const table = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  // Trang cha vẽ lại mỗi 2,5 giây (hỏi tiến trình): giữ toast trong ref để không tải lại câu thoại mỗi lần.
  const stable = useRef(toast);
  stable.current = toast;

  // Gõ tìm: chờ 250 ms rồi mới gọi server; bỏ kết quả của yêu cầu cũ hơn.
  useEffect(() => {
    const seq = ++loadSeq.current;
    const t = setTimeout(async () => {
      const params = new URLSearchParams({ id: jobId, offset: String(q.offset), limit: String(LIMIT), q: q.text, only: q.only });
      const d = await getJSON<Page>("/api/dub/segments?" + params);
      if (seq !== loadSeq.current) return;
      if (d.error) return stable.current(d.error, "error");
      setPage(d);
      if (table.current) table.current.scrollTop = 0;
    }, q.text ? 250 : 0);
    return () => clearTimeout(t);
  }, [jobId, q, reloadKey, resetKey]);

  const spkKeys = speakers.map(([k]) => k);
  const seek = (t: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = t;
    el.play();
  };

  return (
    <div className="script">
      <div className="script-tools">
        <input
          className="input input-sm"
          type="search"
          placeholder="Tìm lời Việt hoặc tiếng Trung..."
          aria-label="Tìm câu thoại"
          onChange={(e) => setQ({ ...q, text: e.target.value, offset: 0 })}
        />
        <label className="check" title="Chỉ hiện câu chưa có lời Việt">
          <input type="checkbox" onChange={(e) => setQ({ ...q, only: e.target.checked ? "empty" : "", offset: 0 })} /> Chưa dịch{" "}
          <span className="cnt">{page?.empty ?? 0}</span>
        </label>
      </div>
      <div className="line-list" ref={table} role="list" aria-label="Danh sách câu thoại">
        {!page ? (
          <p className="muted line-empty">Đang tải...</p>
        ) : page.items.length ? (
          page.items.map((s) => {
            const id = String(s.id);
            const who = spk[id] || s.speaker || "NV1";
            return (
              <div role="listitem" key={id} className={`line ${id in edits || id in spk ? "edited" : ""}`}>
                <div className="line-head">
                  <button className="time-btn" type="button" title="Phát từ mốc này" onClick={() => seek(s.start)}>
                    {fmtDur(s.start) || "0:00"}
                  </button>
                  <span className="line-zh" title={s.zh}>{s.zh}</span>
                  {spkKeys.length > 0 && (
                    <select
                      className={`select input-sm seg-spk spk-${spkIndex(who)}`}
                      aria-label={`Nhân vật câu ${id}`}
                      value={who}
                      onChange={(e) => setMap(spk, setSpk, id, e.target.value, s.speaker || "NV1")}
                    >
                      <Options list={speakers.map(([k, sp]) => [k, sp.name ? `${k} · ${sp.name}${sp.is_new ? " (mới)" : ""}` : k])} />
                    </select>
                  )}
                </div>
                <input
                  className="input input-sm seg-vi"
                  type="text"
                  aria-label={`Lời Việt câu ${id}`}
                  placeholder="(chưa có lời Việt)"
                  value={id in edits ? edits[id] : s.vi}
                  onChange={(e) => {
                    const next = { ...edits };
                    if (e.target.value.trim() !== s.vi) next[id] = e.target.value;
                    else delete next[id];
                    setEdits(next);
                  }}
                />
              </div>
            );
          })
        ) : (
          <p className="muted line-empty">Không có câu nào khớp.</p>
        )}
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
  );
}
