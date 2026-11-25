"use client";
import { createContext, useCallback, useContext, useState } from "react";

type ToastType = "info" | "success" | "error";
type Toast = { id: number; msg: string; type: ToastType; hide: boolean };

const ToastContext = createContext<(msg: string, type?: ToastType) => void>(() => {});
export const useToast = () => useContext(ToastContext);

let seq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, type: ToastType = "info") => {
    const id = ++seq;
    setItems((xs) => [...xs, { id, msg, type, hide: false }]);
    setTimeout(() => setItems((xs) => xs.map((t) => (t.id === id ? { ...t, hide: true } : t))), 3800);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div id="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.type} ${t.hide ? "hide" : ""}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
