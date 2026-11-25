"use client";
import { useProjectId } from "@/lib/project";
import { Icon } from "./Icon";
import { Topbar, useOpenDrawer } from "./Shell";

/** Thanh tiêu đề trang trong dự án: có nút mở Ngữ cảnh AI. */
export function ProjectTopbar({ title, sub }: { title: string; sub: string }) {
  const id = useProjectId();
  const openDrawer = useOpenDrawer();
  return (
    <Topbar
      title={title}
      sub={sub}
      actions={
        <button className="btn btn-light" type="button" onClick={() => openDrawer(id)}>
          <Icon name="brain" size={16} />
          <span className="lbl">Ngữ cảnh AI</span>
        </button>
      }
    />
  );
}
