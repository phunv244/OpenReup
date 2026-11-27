"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import { Options, copyText } from "@/components/ui";
import { DouyinVideo, douyinFileUrl, postJSON } from "@/lib/api";
import { STATUS_LABEL, epText, videoKey } from "@/lib/douyin";
import { fmtDur } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";
import { Cover, SeasonBadge } from "./badges";

/** Cửa sổ chi tiết 1 video Douyin: xem/tải, mở link gốc, đổi trạng thái reup. */
export function VideoDetail({ v, onClose }: { v: DouyinVideo; onClose: () => void }) {
  const toast = useToast();
  const pid = useProjectId();
  const { startTask, reload } = useStudio();
  const [status, setStatus] = useState(v.reup_status === "reupped" || v.reup_status === "downloaded" ? v.reup_status : "pending");
  const kv: [string, React.ReactNode][] = [
    ["Phần / Tập", <><SeasonBadge v={v} /> {v.episode_label ? `Tập ${v.episode_label}` : ""}</>],
    ["Ngày đăng", v.publish_date || "—"],
    ["Thời lượng", fmtDur(v.duration_sec) || "—"],
    ["Lượt thích", v.likes_raw || v.likes || 0],
    ["Bình luận", v.comments_raw || v.comments || 0],
    ["Lượt lưu", v.collects_raw || v.collects || 0],
    ["Chia sẻ", v.shares_raw || v.shares || 0],
    ["Mã video", <code key="c">{v.aweme_id}</code>],
    ["File đã tải", v.local_file ? <code key="f">downloads/{v.local_file}</code> : <span className="muted">Chưa tải</span>],
  ];
  return (
    <Modal title={epText(v)} onClose={onClose} size="wide">
      <div className="detail">
        <div>
          <div className="detail-media">
            {v.local_file ? <video src={douyinFileUrl(v.local_file)} controls /> : v.cover_url ? <Cover v={v} /> : <span className="muted">Không có ảnh bìa</span>}
          </div>
          <div className="actions">
            {v.local_file ? (
              <a className="btn btn-success" href={douyinFileUrl(v.local_file)} download>
                <Icon name="download" size={16} /> Lưu file MP4
              </a>
            ) : v.download_url ? (
              <button className="btn btn-primary" type="button" onClick={() => startTask("/api/download", { ids: v.aweme_id, project_id: pid }, "Đang tải video")}>
                <Icon name="download" size={16} /> Tải về máy
              </button>
            ) : null}
            {v.video_url && (
              <>
                <a className="btn btn-light" href={v.video_url} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={15} /> Mở trên Douyin
                </a>
                <button className="btn btn-quiet" type="button" onClick={() => copyText(v.video_url!, toast)}>
                  <Icon name="copy" size={15} /> Sao chép link
                </button>
              </>
            )}
          </div>
        </div>
        <div>
          <h4>{v.title}</h4>
          <dl className="kv">
            {kv.map(([k, val]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
          <div className="field">
            <label htmlFor="dt-status">Trạng thái reup</label>
            <select
              id="dt-status"
              className="select"
              value={status}
              onChange={async (e) => {
                const s = e.target.value;
                const d = await postJSON("/api/status", { key: videoKey(v), status: s });
                if (!d.ok) return toast(d.error || "Không lưu được trạng thái", "error");
                setStatus(s);
                toast(`Đã chuyển sang "${STATUS_LABEL[s]}"`, "success");
                reload();
              }}
            >
              <Options list={Object.entries(STATUS_LABEL)} />
            </select>
          </div>
        </div>
      </div>
    </Modal>
  );
}
