"use client";
/** Một dự án ở dạng thẻ (lưới) hoặc hàng (danh sách). Bấm cả thẻ là mở (không cần biểu tượng hay nút ">" riêng); nút bánh răng mở Ngữ cảnh AI. */
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { useOpenDrawer } from "@/components/Shell";
import { Project } from "@/lib/api";
import { projHref } from "@/lib/format";

/** 1 dòng tóm tắt: chỉ nêu phần chưa xong ("3 video · 1 chưa lồng"); dự án trống ghi "Chưa có video". */
function statLine(p: Project) {
  const n = p.video_count || 0;
  if (!n) return "Chưa có video";
  return p.pending_count ? `${n} video · ${p.pending_count} chưa lồng` : `${n} video · đã lồng hết`;
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

export function ProjectCard({ p }: { p: Project }) {
  return (
    <article className="pcard" {...useOpen(p)}>
      <div className="pcard-top">
        <div className="pcard-head">
          <div className="pcard-title" title={p.name}>{p.name}</div>
          <span className="pcard-type">{p.type || "Truyện / Hoạt hình"}</span>
        </div>
        <SettingsBtn p={p} className="pcard-set" />
      </div>
      <p className={`pcard-syn ${p.synopsis ? "" : "pcard-syn-empty"}`}>{p.synopsis || "Chưa có mô tả cốt truyện — thêm bối cảnh để AI dịch đúng mạch truyện hơn."}</p>
      <div className="pcard-stats">
        <span className={p.pending_count ? "warn" : ""}>{statLine(p)}</span>
      </div>
    </article>
  );
}

export function ProjectRow({ p }: { p: Project }) {
  return (
    <div className="prow" {...useOpen(p)}>
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
