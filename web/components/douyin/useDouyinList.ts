"use client";
/** Trạng thái bộ lọc + danh sách đã lọc/sắp xếp/phân trang cho tab Danh sách video. */
import { useDeferredValue, useState } from "react";
import { DouyinVideo } from "@/lib/api";
import { useStudio } from "@/lib/studio";

const PAGE_SIZE = 24;
export type Season = "all" | "p1" | "p2" | "other";
export type View = "grid" | "table";

export function useDouyinList() {
  const { videos } = useStudio();
  const [f, setF] = useState({ season: "all" as Season, q: "", sort: "time_desc", status: "all", view: "grid" as View, page: 1 });
  const q = useDeferredValue(f.q.trim().toLowerCase());
  const [detail, setDetail] = useState<DouyinVideo | null>(null);
  const upd = (patch: Partial<typeof f>) => setF({ ...f, page: 1, ...patch });

  const list = videos.filter((v) => {
    if (f.season !== "all" && v._season !== f.season) return false;
    if (f.status !== "all" && v._status !== f.status) return false;
    if (!q) return true;
    return (v.title || "").toLowerCase().includes(q) || String(v.episode_label || "") === q || (v.publish_date || "").includes(q) || (v.aweme_id || "").includes(q);
  });
  const byTime = (a: DouyinVideo, b: DouyinVideo) => (a.publish_time || 0) - (b.publish_time || 0);
  const sorters: Record<string, (a: DouyinVideo, b: DouyinVideo) => number> = {
    time_desc: (a, b) => -byTime(a, b),
    time_asc: byTime,
    ep_asc: (a, b) => (a.episode_num ?? 1e9) - (b.episode_num ?? 1e9) || byTime(a, b),
    ep_desc: (a, b) => (b.episode_num ?? -1) - (a.episode_num ?? -1) || -byTime(a, b),
    likes_desc: (a, b) => (b.likes || 0) - (a.likes || 0),
  };
  list.sort(sorters[f.sort] || sorters.time_desc);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const start = (page - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  const c = { all: videos.length, p1: 0, p2: 0, other: 0 };
  videos.forEach((v) => c[v._season]++);
  return { videos, f, setF, upd, detail, setDetail, list, pages, page, start, slice, c };
}
