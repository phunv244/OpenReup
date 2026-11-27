"use client";
/**
 * Hệ thống thông báo: toast nổi góc trên-phải (dễ thấy hơn góc dưới) + trung tâm thông báo (chuông trên thanh tiêu đề)
 * giữ lại lịch sử để không bỏ lỡ thông báo đã tự ẩn. API cũ `toast(msg, type)` giữ nguyên.
 * CSS riêng: app/notifications.css.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type ToastType = "info" | "success" | "warning" | "error";
type Toast = { id: number; msg: string; type: ToastType; hide: boolean; ms: number };
export type Notice = { id: number; msg: string; type: ToastType; at: number; read: boolean };

const TITLE: Record<ToastType, string> = { info: "Thông báo", success: "Thành công", warning: "Lưu ý", error: "Có lỗi" };
const ICON: Record<ToastType, string> = { info: "info", success: "check", warning: "alert", error: "alert" };
/** Lỗi ở lâu hơn để kịp đọc; rê chuột vào toast thì dừng đếm. */
const DURATION: Record<ToastType, number> = { info: 5000, success: 4500, warning: 7000, error: 9000 };
const MAX_VISIBLE = 4;
const MAX_HISTORY = 60;
const KEY = "notices";

const ToastContext = createContext<(msg: string, type?: ToastType) => void>(() => {});
export const useToast = () => useContext(ToastContext);

type Center = { items: Notice[]; unread: number; markRead: (ids: number[]) => void; clear: () => void; remove: (id: number) => void };
const CenterContext = createContext<Center>({ items: [], unread: 0, markRead: () => {}, clear: () => {}, remove: () => {} });
export const useNotices = () => useContext(CenterContext);

let seq = Date.now();

function ToastItem({ t, onClose }: { t: Toast; onClose: () => void }) {
  const left = useRef(t.ms);
  const since = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const start = useCallback(() => {
    since.current = Date.now();
    timer.current = setTimeout(() => closeRef.current(), left.current);
  }, []);
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, [start]);
  return (
    <div
      className={`toast t-${t.type} ${t.hide ? "hide" : ""} ${paused ? "paused" : ""}`}
      role={t.type === "error" ? "alert" : "status"}
      style={{ "--toast-ms": `${t.ms}ms` } as React.CSSProperties}
      onMouseEnter={() => {
        clearTimeout(timer.current);
        left.current -= Date.now() - since.current;
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
        start();
      }}
    >
      <span className="toast-ico">
        <Icon name={ICON[t.type]} size={16} />
      </span>
      <div className="toast-body">
        <b>{TITLE[t.type]}</b>
        <p>{t.msg}</p>
      </div>
      <button className="toast-x" type="button" aria-label="Đóng thông báo" onClick={onClose}>
        <Icon name="x" size={14} />
      </button>
      <span className="toast-bar" />
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  // Đọc lịch sử một lần; chỉ ghi lại localStorage sau khi đã đọc xong (ready) để mảng rỗng ban đầu không đè mất lịch sử.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setNotices(JSON.parse(localStorage.getItem(KEY) || "[]"));
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(notices));
    } catch {}
  }, [notices, ready]);
  const save = (fn: (xs: Notice[]) => Notice[]) => setNotices((xs) => fn(xs).slice(0, MAX_HISTORY));

  const close = useCallback((id: number) => {
    setItems((xs) => xs.map((t) => (t.id === id ? { ...t, hide: true } : t)));
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 260);
  }, []);

  const toast = useCallback((msg: string, type: ToastType = "info") => {
    const id = ++seq;
    // Cùng nội dung bắn liên tiếp (vd. lỗi poll) → không chồng thêm toast mới.
    setItems((xs) => (xs.some((t) => t.msg === msg && !t.hide) ? xs : [...xs, { id, msg, type, hide: false, ms: DURATION[type] }].slice(-MAX_VISIBLE)));
    save((xs) => (xs[0]?.msg === msg && Date.now() - xs[0].at < 3000 ? xs : [{ id, msg, type, at: Date.now(), read: false }, ...xs]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const center: Center = {
    items: notices,
    unread: notices.filter((n) => !n.read).length,
    markRead: (ids) => {
      const set = new Set(ids);
      save((xs) => xs.map((n) => (set.has(n.id) ? { ...n, read: true } : n)));
    },
    clear: () => save(() => []),
    remove: (id) => save((xs) => xs.filter((n) => n.id !== id)),
  };

  return (
    <ToastContext.Provider value={toast}>
      <CenterContext.Provider value={center}>
        {children}
        <div id="toasts" aria-live="polite">
          {items.map((t) => (
            <ToastItem key={t.id} t={t} onClose={() => close(t.id)} />
          ))}
        </div>
      </CenterContext.Provider>
    </ToastContext.Provider>
  );
}

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(at).toLocaleDateString("vi-VN");
};

/** Nút chuông + bảng lịch sử thông báo (đặt trên thanh tiêu đề). */
export function NotificationBell() {
  const { items, unread, markRead, clear, remove } = useNotices();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Mở bảng: sau 1,2s đánh dấu đã đọc đúng những thông báo đang có lúc mở; đóng bảng sớm thì hủy.
  // Thông báo đến sau khi mở vẫn giữ trạng thái chưa đọc.
  const markRef = useRef(markRead);
  markRef.current = markRead;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!open) return;
    const ids = itemsRef.current.filter((n) => !n.read).map((n) => n.id);
    if (!ids.length) return;
    const t = setTimeout(() => markRef.current(ids), 1200);
    return () => clearTimeout(t);
  }, [open]);
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
  return (
    <div className="notif" ref={box}>
      <button
        className={`icon-btn notif-btn ${open ? "on" : ""}`}
        type="button"
        title="Thông báo"
        aria-label={unread ? `Thông báo, ${unread} chưa đọc` : "Thông báo"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="notif-count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Thông báo">
          <header className="notif-head">
            <b>Thông báo</b>
            {items.length > 0 && (
              <button className="btn btn-quiet btn-sm" type="button" onClick={clear}>
                Xóa hết
              </button>
            )}
          </header>
          <div className="notif-list">
            {items.length ? (
              items.map((n) => (
                <div key={n.id} className={`notif-item t-${n.type} ${n.read ? "" : "unread"}`}>
                  <span className="toast-ico">
                    <Icon name={ICON[n.type]} size={14} />
                  </span>
                  <div className="notif-text">
                    <p>{n.msg}</p>
                    <span>{TITLE[n.type]} · {ago(n.at)}</span>
                  </div>
                  <button className="toast-x" type="button" aria-label="Xóa thông báo này" onClick={() => remove(n.id)}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
              ))
            ) : (
              <div className="notif-empty">
                <Icon name="bell" size={22} />
                <span>Chưa có thông báo nào</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
