"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useRef, useState } from "react";
import { projHref, taskName } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { Icon } from "./Icon";
import { ProjectDrawer } from "./ProjectDrawer";
import { Resizer } from "./Resizer";
import { TaskCard } from "./TaskCard";
import { TaskRail } from "./TaskRail";
import { NotificationBell } from "./Toasts";

/** Mở ngăn "Ngữ cảnh AI" của một dự án từ bất kỳ đâu (thanh trái, thẻ dự án, thanh tiêu đề). */
const DrawerContext = createContext<(pid: string) => void>(() => {});
export const useOpenDrawer = () => useContext(DrawerContext);

/** Cột "Tiến trình & nhật ký" bên phải: đóng mặc định, mở khi cần (nhớ lựa chọn trong localStorage). */
const RailContext = createContext<{ open: boolean; toggle: (v?: boolean) => void }>({ open: false, toggle: () => {} });
export const useRail = () => useContext(RailContext);

/** Thanh trái thu gọn thành dải icon (data-sb="mini" trên <html>, nhớ trong localStorage) — thêm chỗ làm việc trên màn rộng. */
function useSidebarMini() {
  const [mini, setMini] = useState(false);
  useEffect(() => setMini(document.documentElement.dataset.sb === "mini"), []);
  const set = (next: boolean) => {
    if ((document.documentElement.dataset.sb === "mini") === next) return;
    document.documentElement.dataset.sb = next ? "mini" : "full";
    localStorage.setItem("sb", next ? "mini" : "full");
    setMini(next);
  };
  // Đọc trạng thái thật từ <html> (không dùng giá trị state cũ trong closure của phím tắt).
  const toggle = () => set(document.documentElement.dataset.sb !== "mini");
  // Ctrl/⌘ + B bật/tắt (như VS Code); ở màn hẹp thanh trái đã là menu trượt nên bỏ qua.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && window.innerWidth > 900) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { mini, toggle, set };
}

const clean = (p: string) => p.replace(/\/+$/, "") || "/";

function NavLink({ href, icon, label, count, active }: { href: string; icon: string; label: string; count?: number; active: boolean }) {
  return (
    <Link className={`nav-link ${active ? "active" : ""}`} href={href} title={label} aria-current={active ? "page" : undefined}>
      <Icon name={icon} />
      <span>{label}</span>
      {count != null && <span className="nav-count">{count}</span>}
    </Link>
  );
}

function Nav() {
  const { projects, sources, videos, fonts, voices } = useStudio();
  const openDrawer = useOpenDrawer();
  const path = clean(usePathname());
  const params = useSearchParams();
  const pid = params.get("id") || "";
  const proj = path.startsWith("/project/") ? projects.find((p) => p.id === pid) : null;

  if (proj) {
    const sub = path.split("/")[2] || "videos";
    return (
      <nav className="nav" aria-label="Điều hướng dự án">
        <Link className="sb-back" href="/" title="Tất cả Reup">
          <Icon name="back" size={15} /> <span>Tất cả Reup</span>
        </Link>
        <div className="sb-proj">
          <div className="sb-proj-label">Reup · Dự án</div>
          <div className="sb-proj-name" title={proj.name}>
            {proj.name}
          </div>
        </div>
        <NavLink href={projHref(pid, "videos")} icon="film" label="Video & Lồng tiếng" active={sub === "videos" || sub === "video"}
          count={sources.filter((s) => s.project_id === pid).length} />
        <NavLink href={projHref(pid, "douyin")} icon="list" label="Kho Douyin" active={sub === "douyin"} count={videos.length} />
        <button className="nav-link" type="button" title="Ngữ cảnh AI" onClick={() => openDrawer(pid)}>
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
      <NavLink href="/" icon="folder" label="Reup" count={projects.length} active={path === "/" || path.startsWith("/project")} />
      <NavLink href="/resources/" icon="type" label="Tài nguyên" active={path === "/resources"} count={fonts.length + voices.clones.length} />
    </nav>
  );
}

function useTheme() {
  const [theme, setTheme] = useState("dark");
  useEffect(() => setTheme(document.documentElement.dataset.theme || "dark"), []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    setTheme(next);
  };
  return { theme, flip };
}

/** Menu "Cài đặt" ở chân thanh trái: Mô hình nhận diện, Nhật ký hệ thống, Hướng dẫn, đổi giao diện. */
function SettingsMenu() {
  const { asr } = useStudio();
  const path = clean(usePathname());
  const { theme, flip } = useTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const here = ["/models", "/logs", "/help"].includes(path);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const installed = asr.models.filter((m) => m.installed).length;
  return (
    <div className="sb-settings" ref={box}>
      {open && (
        <div className="sb-menu" role="menu" aria-label="Cài đặt">
          <div className="sb-menu-label">Hệ thống</div>
          <Link role="menuitem" className={`sb-menu-item ${path === "/models" ? "active" : ""}`} href="/models/">
            <Icon name="brain" size={16} />
            <span>Mô hình nhận diện</span>
            <em>{installed}</em>
          </Link>
          <Link role="menuitem" className={`sb-menu-item ${path === "/logs" ? "active" : ""}`} href="/logs/">
            <Icon name="terminal" size={16} />
            <span>Nhật ký hệ thống</span>
          </Link>
          <Link role="menuitem" className={`sb-menu-item ${path === "/help" ? "active" : ""}`} href="/help/">
            <Icon name="help" size={16} />
            <span>Hướng dẫn</span>
          </Link>
          <div className="sb-menu-sep" />
          <button role="menuitem" className="sb-menu-item" type="button" onClick={flip}>
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
            <span>{theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}</span>
          </button>
        </div>
      )}
      <button
        className={`sb-tool sb-settings-btn ${open || here ? "on" : ""}`}
        type="button"
        title="Cài đặt"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="settings" size={16} />
        <span>Cài đặt</span>
        <Icon name="chevron" size={14} />
      </button>
    </div>
  );
}

/** Khung app: thanh trái + nội dung + cột tiến trình bên phải. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { projects } = useStudio();
  const path = usePathname();
  const [drawerPid, setDrawerPid] = useState("");
  const drawerProj = projects.find((p) => p.id === drawerPid);
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => setRailOpen(document.documentElement.dataset.rail === "open"), []);
  const toggleRail = (v?: boolean) =>
    setRailOpen((cur) => {
      const next = v ?? !cur;
      document.documentElement.dataset.rail = next ? "open" : "closed";
      localStorage.setItem("rail", next ? "open" : "closed");
      return next;
    });
  const sb = useSidebarMini();
  // Đóng menu trượt (màn hẹp) khi chuyển trang
  useEffect(() => document.body.classList.remove("sb-open"), [path]);

  return (
    <DrawerContext.Provider value={setDrawerPid}>
    <RailContext.Provider value={{ open: railOpen, toggle: toggleRail }}>
      <div className="app">
        <aside className="sidebar">
          <Resizer
            cssVar="sb-w"
            min={200}
            max={420}
            side="left"
            snapAt={150}
            onSnap={sb.set}
            label="Kéo để đổi độ rộng thanh bên trái — kéo hẹp hẳn để thu thành dải icon"
          />
          <button
            className="icon-btn sb-collapse"
            type="button"
            title={sb.mini ? "Mở rộng thanh bên (Ctrl+B)" : "Thu gọn thanh bên (Ctrl+B)"}
            aria-label={sb.mini ? "Mở rộng thanh bên" : "Thu gọn thanh bên"}
            aria-expanded={!sb.mini}
            onClick={sb.toggle}
          >
            <Icon name={sb.mini ? "sidebarOpen" : "sidebar"} size={17} />
          </button>
          <Link className="brand" href="/" title="OpenReup Studio">
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
            <SettingsMenu />
          </div>
        </aside>

        <div className="main">{children}</div>
        {railOpen && <TaskRail onClose={() => toggleRail(false)} />}
        <div className="sb-backdrop" onClick={() => document.body.classList.remove("sb-open")} />
      </div>
      {drawerProj && <ProjectDrawer project={drawerProj} onClose={() => setDrawerPid("")} />}
    </RailContext.Provider>
    </DrawerContext.Provider>
  );
}

/** Thanh tiêu đề của mỗi trang. */
export function Topbar({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  const { reload, task } = useStudio();
  const rail = useRail();
  const busy = Boolean(task?.running) || (task?.queue || []).length > 0;
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
        <button className="task-chip" type="button" title="Xem tiến trình" onClick={() => rail.toggle(true)}>
          <span className="dot" />
          <span className="chip-name">{taskName(task.task_type)} ·</span> {pct}%
        </button>
      )}
      <div className="topbar-actions">
        {actions}
        <NotificationBell />
        <button
          className={`icon-btn rail-toggle ${rail.open ? "on" : ""}`}
          type="button"
          title={rail.open ? "Ẩn tiến trình & nhật ký" : "Xem tiến trình & nhật ký"}
          aria-label="Tiến trình & nhật ký"
          aria-pressed={rail.open}
          onClick={() => rail.toggle()}
        >
          <Icon name="terminal" />
          {busy && <span className="rail-toggle-dot" />}
        </button>
        <button className="icon-btn" type="button" title="Làm mới dữ liệu" aria-label="Làm mới dữ liệu" onClick={() => reload(true)}>
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
