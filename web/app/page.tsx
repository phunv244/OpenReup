"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Topbar, useOpenDrawer } from "@/components/Shell";
import { Seg } from "@/components/ui";
import { useToast } from "@/components/Toasts";
import { Project, postJSON } from "@/lib/api";
import { projHref } from "@/lib/format";
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

type View = "grid" | "list";
type Filter = "all" | "dubbed" | "pending" | "empty";
type Sort = "updated" | "name" | "videos";
const PREF_KEY = "reup.projects.view";

function projIcon(p: Project) {
  return p.type?.includes("Phim") ? "film" : p.type?.includes("Review") ? "book" : "sparkles";
}

/** Bấm vào là mở dự án; nút bánh răng mở Ngữ cảnh AI mà không mở dự án. */
function useOpen(p: Project) {
  const router = useRouter();
  const open = () => router.push(projHref(p.id, "videos"));
  return {
    role: "link" as const,
    tabIndex: 0,
    "aria-label": `Mở dự án ${p.name}`,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && e.target === e.currentTarget && open(),
  };
}

function SettingsBtn({ p, className }: { p: Project; className: string }) {
  const openDrawer = useOpenDrawer();
  return (
    <button
      className={`icon-btn ${className}`}
      type="button"
      title="Ngữ cảnh AI & cài đặt dự án"
      aria-label={`Ngữ cảnh AI & cài đặt dự án ${p.name}`}
      onClick={(e) => {
        e.stopPropagation();
        openDrawer(p.id);
      }}
    >
      <Icon name="sliders" size={17} />
    </button>
  );
}

function ProjectCard({ p }: { p: Project }) {
  return (
    <article className="pcard" {...useOpen(p)}>
      <div className="pcard-top">
        <div className="pcard-ico">
          <Icon name={projIcon(p)} size={20} />
        </div>
        <div className="pcard-head">
          <div className="pcard-title" title={p.name}>{p.name}</div>
          <span className="pcard-type">{p.type || "Truyện / Hoạt hình"}</span>
        </div>
        <SettingsBtn p={p} className="pcard-set" />
      </div>
      <p className={`pcard-syn ${p.synopsis ? "" : "pcard-syn-empty"}`}>{p.synopsis || "Chưa có mô tả cốt truyện — thêm bối cảnh để AI dịch đúng mạch truyện hơn."}</p>
      <div className="pcard-stats">
        <div>
          <b>{p.video_count || 0}</b>
          <span>video</span>
        </div>
        <div>
          <b className="ok">{p.dubbed_count || 0}</b>
          <span>đã lồng tiếng</span>
        </div>
        <div>
          <b className={p.pending_count ? "warn" : ""}>{p.pending_count || 0}</b>
          <span>chưa lồng</span>
        </div>
        <span className="pcard-go" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </div>
    </article>
  );
}

function ProjectRow({ p }: { p: Project }) {
  return (
    <div className="prow" {...useOpen(p)}>
      <div className="pcard-ico prow-ico">
        <Icon name={projIcon(p)} size={16} />
      </div>
      <div className="prow-name">
        <b title={p.name}>{p.name}</b>
        <span>{p.type || "Truyện / Hoạt hình"}</span>
      </div>
      <span className="prow-num" title="Video">{p.video_count || 0}</span>
      <span className="prow-num ok" title="Đã lồng tiếng">{p.dubbed_count || 0}</span>
      <span className={`prow-num ${p.pending_count ? "warn" : ""}`} title="Chưa lồng tiếng">{p.pending_count || 0}</span>
      <span className="prow-date">{p.updated_at ? new Date(p.updated_at).toLocaleDateString("vi-VN") : "—"}</span>
      <SettingsBtn p={p} className="prow-set" />
    </div>
  );
}

function usePrefs() {
  const [prefs, setPrefs] = useState<{ view: View; filter: Filter; sort: Sort }>({ view: "grid", filter: "all", sort: "updated" });
  useEffect(() => {
    try {
      // Chỉ khôi phục kiểu hiển thị và sắp xếp; bộ lọc luôn về "Tất cả" khi mở trang.
      const { view, sort } = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
      setPrefs((p) => ({ ...p, ...(view && { view }), ...(sort && { sort }) }));
    } catch {}
  }, []);
  const update = (patch: Partial<typeof prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      localStorage.setItem(PREF_KEY, JSON.stringify({ view: next.view, sort: next.sort }));
      return next;
    });
  return [prefs, update] as const;
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();

export default function ProjectsPage() {
  const { projects } = useStudio();
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  // Link kiểu giao diện cũ (#/project/<id>/<trang>) vẫn mở đúng trang mới.
  useEffect(() => {
    const m = location.hash.match(/^#\/project\/([^/]+)(?:\/([a-z]+))?/);
    if (m) router.replace(projHref(decodeURIComponent(m[1]), ["douyin", "logs"].includes(m[2]) ? m[2] : "videos"));
    else if (/^#\/(models|logs|help)/.test(location.hash)) router.replace(`/${location.hash.slice(2).split("/")[0]}/`);
  }, [router]);
  const [prefs, setPrefs] = usePrefs();
  const [q, setQ] = useState("");

  const counts = useMemo(
    () => ({
      all: projects.length,
      dubbed: projects.filter((p) => (p.dubbed_count || 0) > 0).length,
      pending: projects.filter((p) => (p.pending_count || 0) > 0).length,
      empty: projects.filter((p) => !p.video_count).length,
    }),
    [projects],
  );

  const shown = useMemo(() => {
    const needle = norm(q.trim());
    const list = projects.filter((p) => {
      if (prefs.filter === "dubbed" && !p.dubbed_count) return false;
      if (prefs.filter === "pending" && !p.pending_count) return false;
      if (prefs.filter === "empty" && p.video_count) return false;
      return !needle || norm(`${p.name} ${p.type || ""}`).includes(needle);
    });
    const by: Record<Sort, (a: Project, b: Project) => number> = {
      updated: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
      name: (a, b) => a.name.localeCompare(b.name, "vi"),
      videos: (a, b) => (b.video_count || 0) - (a.video_count || 0),
    };
    return list.sort(by[prefs.sort]);
  }, [projects, prefs.filter, prefs.sort, q]);

  return (
    <>
      <Topbar
        title="Reup"
        sub="Mỗi bộ truyện / phim một dự án Reup — AI nhớ nhân vật, xưng hô và mạch truyện"
        actions={
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> <span className="lbl">Tạo dự án</span>
          </button>
        }
      />
      <main className="content">
        <div className="pbar">
          <label className="pbar-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm dự án…"
              aria-label="Tìm dự án theo tên"
            />
          </label>
          <Seg<Filter>
            label="Lọc dự án"
            value={prefs.filter}
            onChange={(filter) => setPrefs({ filter })}
            items={[
              { v: "all", label: "Tất cả", count: counts.all },
              { v: "dubbed", label: "Đã lồng tiếng", count: counts.dubbed, title: "Dự án có video đã lồng tiếng" },
              { v: "pending", label: "Chưa lồng", count: counts.pending, title: "Dự án còn video chưa lồng tiếng" },
              { v: "empty", label: "Trống", count: counts.empty, title: "Dự án chưa có video" },
            ]}
          />
          <div className="pbar-right">
            <select className="select pbar-sort" aria-label="Sắp xếp" value={prefs.sort} onChange={(e) => setPrefs({ sort: e.target.value as Sort })}>
              <option value="updated">Mới cập nhật</option>
              <option value="name">Tên A→Z</option>
              <option value="videos">Nhiều video</option>
            </select>
            <Seg<View>
              label="Kiểu hiển thị"
              value={prefs.view}
              onChange={(view) => setPrefs({ view })}
              items={[
                { v: "grid", label: <Icon name="grid" size={15} />, title: "Dạng lưới" },
                { v: "list", label: <Icon name="list" size={15} />, title: "Dạng danh sách" },
              ]}
            />
          </div>
        </div>

        {shown.length === 0 && projects.length > 0 ? (
          <div className="pbar-empty">
            Không có dự án nào khớp.{" "}
            <button className="link-btn" type="button" onClick={() => { setQ(""); setPrefs({ filter: "all" }); }}>
              Xóa bộ lọc
            </button>
          </div>
        ) : prefs.view === "list" ? (
          <div className="plist" role="list">
            <div className="prow prow-head" aria-hidden="true">
              <span />
              <span>Dự án</span>
              <span className="prow-num">Video</span>
              <span className="prow-num">Đã lồng</span>
              <span className="prow-num">Chưa lồng</span>
              <span className="prow-date">Cập nhật</span>
              <span />
            </div>
            {shown.map((p) => (
              <div role="listitem" key={p.id}>
                <ProjectRow p={p} />
              </div>
            ))}
            <div role="listitem">
              <button className="prow prow-new" type="button" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> Tạo dự án mới
              </button>
            </div>
          </div>
        ) : (
          <div className="proj-grid">
            {shown.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
            <button className="pcard pcard-new" type="button" onClick={() => setCreating(true)}>
              <span className="plus">
                <Icon name="plus" size={20} />
              </span>
              <b>Tạo dự án mới</b>
              <span>Mỗi bộ truyện / phim một dự án để AI nhớ nhân vật, xưng hô và mạch truyện</span>
            </button>
          </div>
        )}
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}
