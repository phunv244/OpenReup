"use client";
/** Một dự án ở dạng thẻ (lưới) hoặc hàng (danh sách). Bấm vào là mở; nút bánh răng mở Ngữ cảnh AI. */
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { useOpenDrawer } from "@/components/Shell";
import { Project } from "@/lib/api";
import { projHref } from "@/lib/format";

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

export function ProjectCard({ p }: { p: Project }) {
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

export function ProjectRow({ p }: { p: Project }) {
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
