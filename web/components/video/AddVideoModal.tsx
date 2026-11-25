"use client";
/** Thêm video từ Bilibili / YouTube vào dự án đang mở. */
import { useState } from "react";
import { useStudio } from "@/lib/studio";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { useToast } from "../Toasts";

const PRESETS: [string, string][] = [
  ["Hợp tuyển tập 151–200 (~5 tiếng)", "https://www.bilibili.com/video/BV1teKEzeEfZ/"],
  ["Tập lẻ 84 giây (thử nhanh)", "https://www.bilibili.com/video/BV1nHW3z3EhH/"],
];
const SECTIONS: [string, string][] = [
  ["15 phút đầu", "00:00:00,00:15:00"],
  ["Giờ thứ 1", "00:00:00,01:00:00"],
  ["Giờ thứ 2", "01:00:00,02:00:00"],
  ["Cả video", ","],
];
export function AddVideoModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const toast = useToast();
  const { startTask, system } = useStudio();
  const [f, setF] = useState({ url: "", from: "", to: "", pitems: "", playlist: false, quality: "720p" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  async function start() {
    const url = f.url.trim();
    if (!url) return toast("Vui lòng dán link Bilibili hoặc YouTube", "error");
    const from = f.from.trim();
    const to = f.to.trim();
    if (Boolean(from) !== Boolean(to)) return toast("Nhập đủ cả giờ bắt đầu và giờ kết thúc, hoặc để trống cả hai", "error");
    const section = from && to ? `${from}-${to}` : "";
    const ok = await startTask(
      "/api/bilibili/download",
      { url, section, playlist_items: f.pitems.trim(), playlist: f.playlist, quality: f.quality, project_id: projectId },
      section ? `Bắt đầu tải đoạn ${section}` : "Bắt đầu tải video"
    );
    if (ok) onClose();
  }

  return (
    <Modal title="Thêm video từ Bilibili / YouTube" onClose={onClose} size="wide">
      <div className="field">
        <label htmlFor="av-url">Link Bilibili hoặc YouTube</label>
        <input id="av-url" className="input" type="url" autoFocus value={f.url} onChange={set("url")} placeholder="https://www.bilibili.com/video/BV..." />
        <div className="chips">
          {PRESETS.map(([l, u]) => (
            <button key={u} className="chip" type="button" onClick={() => setF({ ...f, url: u })}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="form-grid">
        <fieldset className="group">
          <legend>
            Chỉ tải một đoạn <span className="muted">(tùy chọn)</span>
          </legend>
          <div className="range-row">
            <input className="input" value={f.from} onChange={set("from")} placeholder="00:00:00" aria-label="Từ giờ" />
            <span className="muted">→</span>
            <input className="input" value={f.to} onChange={set("to")} placeholder="01:00:00" aria-label="Đến giờ" />
          </div>
          <div className="chips">
            {SECTIONS.map(([l, s]) => (
              <button key={l} className="chip" type="button" onClick={() => { const [from, to] = s.split(","); setF({ ...f, from, to }); }}>
                {l}
              </button>
            ))}
          </div>
          <div className="help">
            Để trống = tải trọn video bằng 16 kết nối song song (cần <code>aria2c</code>), rớt mạng tự nối tiếp. Cắt đoạn thì tải chậm hơn vì phải đi qua ffmpeg.
          </div>
        </fieldset>
        <fieldset className="group">
          <legend>
            Link nhiều phần (P1, P2...) <span className="muted">(tùy chọn)</span>
          </legend>
          <input className="input" value={f.pitems} onChange={set("pitems")} placeholder="Ví dụ: 1-5 hoặc 1,3,5" aria-label="Chọn Part" />
          <label className="check">
            <input type="checkbox" checked={f.playlist} onChange={set("playlist")} /> Tải tất cả các phần
          </label>
          <div className="help">Mỗi phần thành 1 video riêng trong danh sách.</div>
        </fieldset>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="av-quality">Độ phân giải</label>
          <select id="av-quality" className="select" value={f.quality} onChange={set("quality")}>
            <option value="720p">Tối đa 720p — nhẹ bằng nửa, hợp video dài</option>
            <option value="best">Cao nhất (1080p trở lên)</option>
          </select>
        </div>
        <div className="field">
          <span className="label">Logo</span>
          <div className="help">Tải về giữ nguyên hình. Muốn xóa logo thì bật <b>Xóa logo khi xuất</b> ở bước lồng tiếng và khoanh vùng trên khung hình.</div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="muted">
          <Icon name="disk" size={15} /> Ổ cứng còn trống {system.free_gb || 0} GB
        </span>
        <span className="grow" />
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" type="button" onClick={start}>
          <Icon name="download" size={16} /> Bắt đầu tải
        </button>
      </div>
    </Modal>
  );
}
