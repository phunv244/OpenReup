"use client";
/** Nhãn phần/trạng thái và ảnh bìa dùng chung cho các tab Kho Douyin. */
import { DouyinVideo } from "@/lib/api";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/douyin";

export function SeasonBadge({ v }: { v: DouyinVideo }) {
  if (v._season === "p2") return <span className="badge purple">Phần 2</span>;
  if (v._season === "p1") return <span className="badge amber">Phần 1</span>;
  return <span className="badge gray">Khác</span>;
}
export const StatusBadge = ({ v }: { v: DouyinVideo }) => <span className={`badge ${STATUS_TONE[v._status]}`}>{STATUS_LABEL[v._status]}</span>;

export function Cover({ v, className }: { v: DouyinVideo; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return v.cover_url ? <img className={className} src={v.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.remove()} /> : null;
}
