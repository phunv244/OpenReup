"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { PlayerModal } from "@/components/Modal";
import { Callout, EmptyState, Options } from "@/components/ui";
import { DouyinVideo, douyinFileUrl } from "@/lib/api";
import { fmtDur, fmtHours, projHref } from "@/lib/format";
import { useStudio } from "@/lib/studio";
import { SeasonBadge } from "./badges";

export function BatchTab({ pid }: { pid: string }) {
  const { videos, startTask } = useStudio();
  const [f, setF] = useState({ season: "p2", from: "1", to: "10", skip: true });
  const [play, setPlay] = useState<DouyinVideo | null>(null);
  const from = Number(f.from || 0);
  const to = Number(f.to || 0);
  const sel = videos
    .filter((v) => (f.season === "all" ? v._season !== "other" : v._season === f.season))
    .filter((v) => v.episode_num != null && v.episode_num >= from && v.episode_num <= to)
    .filter((v) => v.download_url && !(f.skip && v.local_file))
    .sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
  const dur = sel.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
  // Nhãn từng phần lấy từ dữ liệu kênh đang quét (không ghi cứng số tập của một kênh cụ thể).
  const seasonLabel = (key: "p1" | "p2", name: string) => {
    const eps = videos.filter((v) => v._season === key && v.episode_num != null).map((v) => v.episode_num as number);
    return eps.length ? `${name} — ${eps.length} tập (tập ${Math.min(...eps)} → ${Math.max(...eps)})` : `${name} — chưa có tập nào`;
  };
  const done = videos.filter((v) => v.local_file).sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));

  if (!videos.length)
    return (
      <EmptyState icon="scan" title="Chưa có tập nào để tải" desc="Quét kênh Douyin trước để có danh sách tập và link tải.">
        <Link className="btn btn-primary" href={projHref(pid, "douyin", "&tab=scan")}>
          Đi tới Quét kênh
        </Link>
      </EmptyState>
    );

  return (
    <>
      <section className="card">
        <header className="card-head">
          <h3>Tải hàng loạt theo tập</h3>
          <span className="hint">
            MP4 gốc từ Douyin, lưu vào <code>downloads/</code>
          </span>
        </header>
        <div className="card-body">
          <div className="form-grid cols-3">
            <div className="field">
              <label htmlFor="dl-season">Phần</label>
              <select id="dl-season" className="select" value={f.season} onChange={(e) => setF({ ...f, season: e.target.value })}>
                <Options list={[["p2", seasonLabel("p2", "Phần 2")], ["p1", seasonLabel("p1", "Phần 1")], ["all", "Cả 2 phần"]]} />
              </select>
            </div>
            <div className="field">
              <label htmlFor="dl-from">Từ tập</label>
              <input id="dl-from" className="input" type="number" min={1} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="dl-to">Đến tập</label>
              <input id="dl-to" className="input" type="number" min={1} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.skip} onChange={(e) => setF({ ...f, skip: e.target.checked })} /> Bỏ qua các tập đã tải
          </label>
          {sel.length ? (
            <Callout tone="info" icon="download">
              Sẽ tải <b>{sel.length} video</b> (tổng khoảng <b>{fmtHours(dur)}</b>), từ “{sel[0].title.slice(0, 36)}…” đến “{sel[sel.length - 1].title.slice(0, 36)}…”
            </Callout>
          ) : (
            <Callout tone="warn" icon="info">
              Không có video nào khớp. Kiểm tra lại phần và khoảng tập, hoặc quét kênh để làm mới link tải.
            </Callout>
          )}
        </div>
        <div className="card-foot">
          <button className="btn btn-primary" type="button" disabled={!sel.length}
            onClick={() => startTask("/api/download", { ids: sel.map((v) => v.aweme_id).join(","), project_id: pid }, `Bắt đầu tải ${sel.length} video`)}>
            <Icon name="download" size={16} /> Bắt đầu tải
          </button>
          <span className="muted">
            Lỗi <code>403</code>? Link tải đã hết hạn — vào tab Quét kênh, bấm Quét nối tiếp rồi tải lại.
          </span>
        </div>
      </section>
      <section className="card">
        <header className="card-head">
          <h3>
            Đã tải về máy <span className="badge green">{done.length}</span>
          </h3>
        </header>
        {done.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Phần / Tập</th><th>Tiêu đề</th><th>Thời lượng</th><th /></tr>
              </thead>
              <tbody>
                {done.map((v) => (
                  <tr key={v.aweme_id}>
                    <td className="nowrap">
                      <SeasonBadge v={v} /> {v.episode_label && <b>Tập {v.episode_label}</b>}
                    </td>
                    <td className="title-cell">{v.title}</td>
                    <td>{fmtDur(v.duration_sec) || "—"}</td>
                    <td className="nowrap">
                      <button className="btn btn-light btn-sm" type="button" onClick={() => setPlay(v)}>
                        <Icon name="play" size={14} /> Xem
                      </button>
                      <a className="btn btn-quiet btn-sm" href={douyinFileUrl(v.local_file!)} download>
                        <Icon name="download" size={14} /> Lưu
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted pad">
            Chưa tải video nào. Video tải xong sẽ tự xuất hiện ở trang <Link href={projHref(pid, "videos")}>Video & Lồng tiếng</Link>.
          </p>
        )}
      </section>
      {play && <PlayerModal src={douyinFileUrl(play.local_file!)} title={play.title} onClose={() => setPlay(null)} />}
    </>
  );
}
