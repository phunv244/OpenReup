"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useState } from "react";
import { projHref, taskName } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { ProjectDrawer } from "./ProjectDrawer";
import { Resizer } from "./Resizer";
import { TaskCard } from "./TaskCard";
import { TaskRail } from "./TaskRail";

/** Mở ngăn "Ngữ cảnh AI" của một dự án từ bất kỳ đâu (thanh trái, thẻ dự án, thanh tiêu đề). */
const DrawerContext = createContext<(pid: string) => void>(() => {});
export const useOpenDrawer = () => useContext(DrawerContext);

const clean = (p: string) => p.replace(/\/+$/, "") || "/";

function NavLink({ href, icon, label, count, active }: { href: string; icon: string; label: string; count?: number; active: boolean }) {
  return (
    <Link className={`nav-link ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined}>
      <Icon name={icon} />
      <span>{label}</span>
      {count != null && <span className="nav-count">{count}</span>}
    </Link>
  );
}

function Nav() {
  const { projects, sources, videos, asr, fonts, voices } = useStudio();
  const openDrawer = useOpenDrawer();
  const path = clean(usePathname());
  const params = useSearchParams();
  const pid = params.get("id") || "";
  const proj = path.startsWith("/project/") ? projects.find((p) => p.id === pid) : null;

  if (proj) {
    const sub = path.split("/")[2] || "videos";
    return (
      <nav className="nav" aria-label="Điều hướng dự án">
        <Link className="sb-back" href="/">
          <Icon name="back" size={15} /> Tất cả dự án
        </Link>
        <div className="sb-proj">
          <div className="sb-proj-label">Dự án</div>
          <div className="sb-proj-name" title={proj.name}>
            {proj.name}
          </div>
        </div>
        <NavLink href={projHref(pid, "videos")} icon="film" label="Video & Lồng tiếng" active={sub === "videos" || sub === "video"}
          count={sources.filter((s) => s.project_id === pid).length} />
        <NavLink href={projHref(pid, "douyin")} icon="list" label="Kho Douyin" active={sub === "douyin"} count={videos.length} />
        <button className="nav-link" type="button" onClick={() => openDrawer(pid)}>
          <Icon name="brain" />
          <span>Ngữ cảnh AI</span>
          <span className="nav-count">{(proj.characters || []).length + (proj.glossary || []).length}</span>
        </button>
        <NavLink href={projHref(pid, "logs")} icon="terminal" label="Nhật ký" active={sub === "logs"} />
      </nav>
    );
  }
  return (
    <nav className="nav" aria-label="Điều hướng chính">
      <NavLink href="/" icon="folder" label="Dự án" count={projects.length} active={path === "/" || path.startsWith("/project")} />
      <NavLink href="/resources/" icon="type" label="Tài nguyên" active={path === "/resources"} count={fonts.length + voices.clones.length} />
      <NavLink href="/models/" icon="brain" label="Mô hình nhận diện" active={path === "/models"} count={asr.models.filter((m) => m.installed).length} />
      <NavLink href="/agy-proxy/" icon="key" label="Tài khoản AGY" active={path === "/agy-proxy"} />
      <NavLink href="/logs/" icon="terminal" label="Nhật ký" active={path === "/logs"} />
    </nav>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState("dark");
  useEffect(() => setTheme(document.documentElement.dataset.theme || "dark"), []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="sb-tool"
      type="button"
      title="Đổi giao diện sáng / tối"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        localStorage.setItem("theme", next);
        setTheme(next);
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      <span>{theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}</span>
    </button>
  );
}

/** Khung app: thanh trái + nội dung + cột tiến trình bên phải. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { projects } = useStudio();
  const path = usePathname();
  const [drawerPid, setDrawerPid] = useState("");
  const drawerProj = projects.find((p) => p.id === drawerPid);
  // Đóng menu trượt (màn hẹp) khi chuyển trang
  useEffect(() => document.body.classList.remove("sb-open"), [path]);

  return (
    <DrawerContext.Provider value={setDrawerPid}>
      <div className="app">
        <aside className="sidebar">
          <Resizer cssVar="sb-w" min={200} max={420} side="left" label="Kéo để đổi độ rộng thanh bên trái" />
          <Link className="brand" href="/">
            <span className="brand-logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            <span>
              <span className="brand-name">OpenReup Studio</span>
              <span className="brand-sub">Tải · Dịch · Lồng tiếng AI</span>
            </span>
          </Link>

          <Suspense fallback={<nav className="nav" />}>
            <Nav />
          </Suspense>

          <div className="sb-foot">
            <TaskCard variant="sidebar" />
            <div className="sb-tools">
              <Link className="sb-tool" href="/help/">
                <Icon name="help" size={16} />
                <span>Hướng dẫn</span>
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <div className="main">{children}</div>
        <TaskRail />
        <div className="sb-backdrop" onClick={() => document.body.classList.remove("sb-open")} />
      </div>
      {drawerProj && <ProjectDrawer project={drawerProj} onClose={() => setDrawerPid("")} />}
    </DrawerContext.Provider>
  );
}

/** Thanh tiêu đề của mỗi trang. */
export function Topbar({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  const { reload, task } = useStudio();
  // Không đặt mảng phụ thuộc: Next đặt lại tiêu đề tab khi đổi ?tab=, nên ghi lại sau mỗi lần vẽ.
  useEffect(() => {
    document.title = `${title} · OpenReup Studio`;
  });
  const pct = Math.round(Number(task?.progress?.pct || 0));
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" type="button" aria-label="Mở menu" onClick={() => document.body.classList.add("sb-open")}>
        <Icon name="menu" />
      </button>
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {task?.running && (
        <Link className="task-chip" href="/logs/">
          <span className="dot" />
          <span className="chip-name">{taskName(task.task_type)} ·</span> {pct}%
        </Link>
      )}
      <div className="topbar-actions">
        {actions}
        <button className="icon-btn" type="button" title="Làm mới dữ liệu" aria-label="Làm mới dữ liệu" onClick={() => reload(true)}>
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
