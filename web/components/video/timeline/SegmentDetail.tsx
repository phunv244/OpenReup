"use client";
import { Speaker } from "@/lib/api";
import { setMap } from "@/lib/editMap";
import { fmtDur } from "@/lib/format";
import { Icon } from "../../Icon";
import { Options } from "../../ui";
import { Seg } from "./timeline-math";

type Props = {
  sel: Seg;
  speakers: [string, Speaker][];
  edits: Record<string, string>;
  setEdits: (m: Record<string, string>) => void;
  spk: Record<string, string>;
  setSpk: (m: Record<string, string>) => void;
  onClose: () => void;
};

/** Ô sửa "câu đang chọn": người nói + lời Việt, ghi vào cùng `edits`/`spk` với bảng lời thoại. */
export function SegmentDetail({ sel, speakers, edits, setEdits, spk, setSpk, onClose }: Props) {
  const id = String(sel.id);
  return (
    <div className="tl-detail">
      <div className="tl-detail-head">
        <span className="muted">
          {fmtDur(sel.start)} – {fmtDur(sel.end)}
        </span>
        {speakers.length > 0 && (
          <select
            className="select input-sm"
            aria-label="Người nói"
            value={spk[id] || sel.speaker || "NV1"}
            onChange={(e) => setMap(spk, setSpk, id, e.target.value, sel.speaker || "NV1")}
          >
            <Options list={speakers.map(([k, s]) => [k, s.name ? `${k} · ${s.name}` : k])} />
          </select>
        )}
        <button className="btn btn-quiet btn-sm" type="button" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="tl-detail-zh muted">{sel.zh || "(không có lời gốc)"}</div>
      <textarea
        className="input tl-detail-vi"
        rows={2}
        aria-label="Lời Việt"
        value={id in edits ? edits[id] : sel.vi}
        onChange={(e) => {
          const next = { ...edits };
          if (e.target.value.trim() !== sel.vi) next[id] = e.target.value;
          else delete next[id];
          setEdits(next);
        }}
      />
    </div>
  );
}
