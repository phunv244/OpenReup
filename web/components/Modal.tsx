"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

type Props = {
  title: string;
  onClose: () => void;
  size?: "" | "wide" | "xl";
  /** true: bấm nền không đóng (hộp thoại có dữ liệu đang sửa) */
  sticky?: boolean;
  children: React.ReactNode;
};

/** Hộp thoại: Esc / nút X / bấm nền để đóng. Đóng thì dừng mọi video bên trong. */
export function Modal({ title, onClose, size = "", sticky = false, children }: Props) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div className="modal-bg" onMouseDown={(e) => !sticky && e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3 title={title}>{title}</h3>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Đóng">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function PlayerModal({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} size="wide">
      <video className="player" src={src} controls autoPlay />
    </Modal>
  );
}
