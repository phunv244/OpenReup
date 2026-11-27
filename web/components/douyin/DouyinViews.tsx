"use client";
/** Hai cách hiển thị danh sách video Douyin: dạng thẻ và dạng bảng. */
import { DouyinVideo } from "@/lib/api";
import { dateOnly } from "@/lib/douyin";
import { fmtDur } from "@/lib/format";
import { Cover, SeasonBadge, StatusBadge } from "./badges";

type Props = { slice: DouyinVideo[]; onOpen: (v: DouyinVideo) => void };

export function DouyinGrid({ slice, onOpen: setDetail }: Props) {
  return (
    <div className="vgrid">
      {slice.map((v) => (
        <article className="vcard" key={v.aweme_id} tabIndex={0} onClick={() => setDetail(v)} onKeyDown={(e) => e.key === "Enter" && setDetail(v)}>
          <div className="vthumb">
            <Cover v={v} />
            <div className="tl">{v.episode_label && <span className="ov">Tập {v.episode_label}</span>}</div>
            <div className="tr">
              {v._season === "p2" ? <span className="ov purple">P2</span> : v._season === "p1" ? <span className="ov amber">P1</span> : null}
            </div>
            <div className="bl">{v.local_file && <span className="ov green">Đã tải</span>}</div>
            <div className="br">{v.duration_sec ? <span className="ov">{fmtDur(v.duration_sec)}</span> : null}</div>
          </div>
          <div className="vbody">
            <div className="vtitle" title={v.title}>
              {v.title}
            </div>
            <div className="vmeta">
              <span>
                {dateOnly(v.publish_date)} · ♥ {v.likes_raw || v.likes || 0}
              </span>
              <StatusBadge v={v} />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

export function DouyinTable({ slice, start, onOpen: setDetail }: Props & { start: number }) {
  return (
    <section className="card">
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th><th>Ảnh</th><th>Phần / Tập</th><th>Tiêu đề</th><th>Ngày đăng</th><th>Thời lượng</th><th>Thích</th><th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((v, i) => (
              <tr className="clickable" key={v.aweme_id} onClick={() => setDetail(v)}>
                <td className="muted">{start + i + 1}</td>
                <td><Cover v={v} className="thumb" /></td>
                <td className="nowrap">
                  <SeasonBadge v={v} /> {v.episode_label && <b>Tập {v.episode_label}</b>}
                </td>
                <td className="title-cell">{v.title}</td>
                <td className="nowrap">{dateOnly(v.publish_date)}</td>
                <td>{fmtDur(v.duration_sec) || "—"}</td>
                <td className="nowrap">{v.likes_raw || v.likes || 0}</td>
                <td><StatusBadge v={v} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
