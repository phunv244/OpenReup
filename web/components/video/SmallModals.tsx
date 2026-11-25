"use client";
/** Các hộp thoại nhỏ của trang Video: xóa logo, chuyển dự án, xóa video. */
import { useState } from "react";
import { postJSON } from "@/lib/api";
import { PERF_OPTIONS, fmtDur, fmtSize, isRegion } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { RegionPicker } from "../RegionPicker";
import { useToast } from "../Toasts";
import { Callout, Options } from "../ui";
import { WorkItem } from "./items";

export function DelogoModal({ v, onClose }: { v: WorkItem; onClose: () => void }) {
  const { startTask } = useStudio();
  const [region, setRegion] = useState("");
  const [perf, setPerf] = useState("balanced");
  async function run() {
    const ok = await startTask("/api/bilibili/delogo", { local_file: v.name, delogo: region, perf }, "Đang xóa logo");
    if (ok) onClose();
  }
  return (
    <Modal title={`Xóa logo · ${v.title}`} onClose={onClose} size="wide">
      <Callout tone="info" icon="info">
        Kéo chuột trên khung hình để khoanh đúng vùng logo. Xóa logo phải mã hóa lại cả video — nếu sắp lồng tiếng, hãy khoanh vùng ở bước lồng tiếng để
        chỉ mã hóa một lần.
      </Callout>
      <RegionPicker rel={v.rel_path} initial={isRegion(v.delogo) ? v.delogo : ""} onChange={setRegion} />
      <div className="field">
        <label htmlFor="md-perf">Mức dùng máy</label>
        <select id="md-perf" className="select" value={perf} onChange={(e) => setPerf(e.target.value)}>
          <Options list={PERF_OPTIONS} />
        </select>
      </div>
      <div className="modal-foot">
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" type="button" disabled={!region} onClick={run}>
          <Icon name="sparkles" size={16} /> Xóa logo
        </button>
      </div>
    </Modal>
  );
}

export function MoveVideoModal({ v, onClose }: { v: WorkItem; onClose: () => void }) {
  const toast = useToast();
  const { projects, reload } = useStudio();
  const others = projects.filter((p) => p.id !== v.project_id);
  const [pid, setPid] = useState(others[0]?.id || "");
  async function move() {
    const d = await postJSON("/api/source/assign", { rel_path: v.rel_path, project_id: pid });
    if (!d.ok) return toast(d.error || "Không chuyển được video", "error");
    toast(`Đã chuyển sang dự án "${projects.find((p) => p.id === pid)?.name}"`, "success");
    onClose();
    reload();
  }
  return (
    <Modal title="Chuyển video sang dự án khác" onClose={onClose}>
      <div className="field">
        <label htmlFor="mv-proj">Chuyển &quot;{v.title}&quot; sang dự án</label>
        <select id="mv-proj" className="select" value={pid} onChange={(e) => setPid(e.target.value)}>
          <Options list={others.map((p) => [p.id, p.name])} />
        </select>
        <div className="help">Chỉ đổi nơi hiển thị. File video và bản lồng tiếng giữ nguyên.</div>
      </div>
      <div className="modal-foot">
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-primary" type="button" disabled={!pid} onClick={move}>
          <Icon name="folder" size={16} /> Chuyển
        </button>
      </div>
    </Modal>
  );
}

export function DeleteVideoModal({ v, onClose }: { v: WorkItem; onClose: () => void }) {
  const toast = useToast();
  const { reload } = useStudio();
  const jobId = v.dub?.job_id || "";
  const [withDub, setWithDub] = useState(true);
  const [busy, setBusy] = useState(false);
  async function del() {
    setBusy(true);
    const d = await postJSON("/api/source/delete", { rel_path: v.rel_path, job_id: jobId, delete_dubbed: jobId ? withDub : false });
    if (!d.ok) {
      setBusy(false);
      return toast(d.error || "Không xóa được video", "error");
    }
    toast("Đã xóa video", "success");
    onClose();
    reload();
  }
  return (
    <Modal title="Xóa video" onClose={onClose}>
      <Callout tone="danger" icon="alert">
        <b>File sẽ bị xóa vĩnh viễn khỏi ổ cứng</b> và không khôi phục được.
      </Callout>
      <div className="file-box">
        <b>{v.title}</b>
        <code>{v.rel_path}</code>
        <span className="muted">
          {fmtSize(v.size_mb)}
          {v.duration_sec ? ` · ${fmtDur(v.duration_sec)}` : ""}
        </span>
      </div>
      {jobId && (
        <label className="check">
          <input type="checkbox" checked={withDub} onChange={(e) => setWithDub(e.target.checked)} /> Xóa luôn bản lồng tiếng Việt, phụ đề và cache
        </label>
      )}
      <div className="modal-foot">
        <button className="btn btn-light" type="button" onClick={onClose}>
          Hủy
        </button>
        <button className="btn btn-danger" type="button" disabled={busy} onClick={del}>
          <Icon name="trash" size={16} /> Xóa vĩnh viễn
        </button>
      </div>
    </Modal>
  );
}
