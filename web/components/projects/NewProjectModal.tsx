"use client";
/** Hộp thoại tạo dự án Reup mới; tạo xong mở thẳng trang Video & Lồng tiếng của dự án. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import { Project, postJSON } from "@/lib/api";
import { projHref } from "@/lib/format";
import { useStudio } from "@/lib/studio";

const TYPES = ["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"];

export function NewProjectModal({ onClose }: { onClose: () => void }) {
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
