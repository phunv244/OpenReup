"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Topbar, useOpenDrawer } from "@/components/Shell";
import { Metric } from "@/components/ui";
import { useToast } from "@/components/Toasts";
import { Project, postJSON } from "@/lib/api";
import { fmtHours, projHref } from "@/lib/format";
import { useStudio } from "@/lib/studio";

const TYPES = ["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"];

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { reload } = useStudio();
  const router = useRouter();
  const [form, setForm] = useState({ name: "", type: TYPES[0], style: "Tự nhiên, gần gũi, giữ đúng xưng hô", synopsis: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return toast("Vui lòng nhập tên dự án", "error");
    setBusy(true);
    const d = await postJSON<{ ok?: boolean; error?: string; project?: Project }>("/api/projects", {
      ...form,
      name: form.name.trim(),
      style: form.style.trim(),
      synopsis: form.synopsis.trim(),
    });
    setBusy(false);
    if (!d.ok) return toast(d.error || "Không tạo được dự án", "error");
    toast(`Đã tạo dự án "${form.name.trim()}"`, "success");
    await reload();
    onClose();
    if (d.project) router.push(projHref(d.project.id, "videos"));
  }

  return (
    <Modal title="Tạo dự án mới" onClose={onClose}>
      <form onSubmit={create}>
        <div className="field">
          <label htmlFor="np-name">Tên dự án (tên bộ truyện / phim)</label>
          <input id="np-name" className="input" autoFocus value={form.name} onChange={set("name")} placeholder="Ví dụ: Đấu Phá Thương Khung" />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="np-type">Thể loại</label>
            <select id="np-type" className="select" value={form.type} onChange={set("type")}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-style">Phong cách dịch</label>
            <input id="np-style" className="input" value={form.style} onChange={set("style")} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="np-syn">Bối cảnh / cốt truyện</label>
          <textarea
            id="np-syn"
            className="input"
            rows={4}
            value={form.synopsis}
            onChange={set("synopsis")}
            placeholder="Nhân vật chính, bối cảnh, quan hệ giữa các nhân vật... AI đọc phần này mỗi lần dịch."
          />
        </div>
        <div className="modal-foot">
          <button className="btn btn-light" type="button" onClick={onClose}>
            Hủy
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            <Icon name="plus" size={16} /> Tạo dự án
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const openDrawer = useOpenDrawer();
  const router = useRouter();
  const open = () => router.push(projHref(p.id, "videos"));
  const ico = p.type?.includes("Phim") ? "film" : p.type?.includes("Review") ? "book" : "sparkles";
  return (
    <article className="pcard" role="link" tabIndex={0} aria-label={`Mở dự án ${p.name}`} onClick={open} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
      <div className="pcard-top">
        <div className="pcard-ico">
          <Icon name={ico} size={22} />
        </div>
        <div className="pcard-head">
          <div className="pcard-title">{p.name}</div>
          <span className="badge violet">{p.type || "Truyện / Hoạt hình"}</span>
        </div>
        <button
          className="icon-btn"
          type="button"
          title="Ngữ cảnh AI & cài đặt dự án"
          onClick={(e) => {
            e.stopPropagation();
            openDrawer(p.id);
          }}
        >
          <Icon name="sliders" />
        </button>
      </div>
      <p className="pcard-syn">{p.synopsis || "Chưa có mô tả cốt truyện. Thêm bối cảnh để AI dịch đúng mạch truyện hơn."}</p>
      <div className="pcard-foot">
        <span>
          <Icon name="mic" size={14} /> {p.video_count || 0} video
        </span>
        <span>
          <Icon name="users" size={14} /> {(p.characters || []).length} nhân vật
        </span>
        <span>
          <Icon name="book" size={14} /> {(p.glossary || []).length} thuật ngữ
        </span>
        <span className="pcard-go">
          Mở <Icon name="chevron" size={15} />
        </span>
      </div>
    </article>
  );
}

export default function ProjectsPage() {
  const { projects, dubbed, system } = useStudio();
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  // Link kiểu giao diện cũ (#/project/<id>/<trang>) vẫn mở đúng trang mới.
  useEffect(() => {
    const m = location.hash.match(/^#\/project\/([^/]+)(?:\/([a-z]+))?/);
    if (m) router.replace(projHref(decodeURIComponent(m[1]), ["douyin", "logs"].includes(m[2]) ? m[2] : "videos"));
    else if (/^#\/(models|logs|help)/.test(location.hash)) router.replace(`/${location.hash.slice(2).split("/")[0]}/`);
  }, [router]);
  const totalSec = dubbed.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
  const totalMem = projects.reduce((a, p) => a + (p.characters || []).length + (p.glossary || []).length, 0);

  return (
    <>
      <Topbar
        title="Dự án"
        sub="Mỗi bộ truyện / phim một dự án — AI nhớ nhân vật, xưng hô và mạch truyện"
        actions={
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> <span className="lbl">Tạo dự án</span>
          </button>
        }
      />
      <main className="content">
        <div className="metrics">
          <Metric icon="folder" label="Dự án" value={projects.length} tone="violet" />
          <Metric icon="mic" label="Video đã lồng tiếng" value={dubbed.length} sub={totalSec ? `Tổng ${fmtHours(totalSec)}` : ""} tone="green" />
          <Metric icon="brain" label="AI đã ghi nhớ" value={totalMem} sub="nhân vật & thuật ngữ" tone="pink" />
          <Metric icon="disk" label="Ổ cứng còn trống" value={`${system.free_gb || 0} GB`} sub={`trên ${system.total_gb || 0} GB`} tone="blue" />
        </div>
        <div className="proj-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
          <button className="pcard pcard-new" type="button" onClick={() => setCreating(true)}>
            <span className="plus">
              <Icon name="plus" size={22} />
            </span>
            <b>Tạo dự án mới</b>
            <span>Mỗi bộ truyện / phim một dự án để AI nhớ nhân vật, xưng hô và mạch truyện</span>
          </button>
        </div>
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}
