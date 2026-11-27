"use client";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { EmptyState, Options, Seg } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/douyin";
import { projHref } from "@/lib/format";
import { DouyinGrid, DouyinTable } from "./DouyinViews";
import { Pager } from "./Pager";
import { Season, View, useDouyinList } from "./useDouyinList";
import { VideoDetail } from "./VideoDetail";

export function ListTab({ pid }: { pid: string }) {
  const { videos, f, setF, upd, detail, setDetail, list, pages, page, start, slice, c } = useDouyinList();

  // Chưa quét kênh: thanh lọc toàn số 0 không có tác dụng — chỉ hiện lời nhắc đi quét.
  if (!videos.length)
    return (
      <EmptyState icon="scan" title="Chưa có video nào" desc="Quét kênh Douyin để lấy danh sách video.">
        <Link className="btn btn-primary" href={projHref(pid, "douyin", "&tab=scan")}>
          Đi tới Quét kênh
        </Link>
      </EmptyState>
    );

  return (
    <>
      <div className="toolbar">
        <Seg<Season>
          value={f.season}
          onChange={(season) => upd({ season })}
          items={(
            [
              ["all", "Tất cả "],
              ["p2", "Phần 2 "],
              ["p1", "Phần 1 "],
              ["other", "Video phụ "],
            ] as [Season, string][]
          ).map(([v, label]) => ({ v, label, count: c[v], disabled: v !== "all" && !c[v] && f.season !== v }))}
        />
        <input className="input" type="search" value={f.q} onChange={(e) => upd({ q: e.target.value })} placeholder="Tìm theo tên, số tập (25), ngày (2026-03)..." aria-label="Tìm video Douyin" />
        <select className="select" aria-label="Sắp xếp" value={f.sort} onChange={(e) => upd({ sort: e.target.value })}>
          <Options list={[["time_desc", "Mới đăng trước"], ["time_asc", "Cũ trước (đúng mạch truyện)"], ["ep_asc", "Số tập tăng dần"], ["ep_desc", "Số tập giảm dần"], ["likes_desc", "Nhiều lượt thích"]]} />
        </select>
        <select className="select" aria-label="Trạng thái" value={f.status} onChange={(e) => upd({ status: e.target.value })}>
          <Options list={[["all", "Mọi trạng thái"], ...Object.entries(STATUS_LABEL)]} />
        </select>
        <Seg<View>
          value={f.view}
          onChange={(view) => setF({ ...f, view })}
          items={[
            { v: "grid", label: <Icon name="grid" size={16} />, title: "Dạng thẻ" },
            { v: "table", label: <Icon name="list" size={16} />, title: "Dạng bảng" },
          ]}
        />
      </div>
      <div className="list-meta">
        <span>
          Hiển thị <b>{list.length ? start + 1 : 0}–{start + slice.length}</b> trong <b>{list.length}</b> video
        </span>
      </div>
      {!list.length ? (
        <EmptyState icon="search" title="Không tìm thấy video phù hợp" desc="Thử đổi bộ lọc hoặc từ khóa tìm kiếm." />
      ) : f.view === "grid" ? (
        <DouyinGrid slice={slice} onOpen={setDetail} />
      ) : (
        <DouyinTable slice={slice} start={start} onOpen={setDetail} />
      )}
      <Pager page={page} pages={pages} go={(n) => { setF({ ...f, page: n }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      {detail && <VideoDetail v={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
