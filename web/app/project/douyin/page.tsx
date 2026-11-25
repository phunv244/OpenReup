"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal, PlayerModal } from "@/components/Modal";
import { ProjectTopbar } from "@/components/ProjectTopbar";
import { ProgressBar } from "@/components/TaskCard";
import { useToast } from "@/components/Toasts";
import { Callout, EmptyState, Options, Seg, copyText } from "@/components/ui";
import { DouyinVideo, douyinFileUrl, postJSON } from "@/lib/api";
import { DEFAULT_CHANNEL_URL, STATUS_LABEL, STATUS_TONE, dateOnly, epText, videoKey } from "@/lib/douyin";
import { fmtDur, fmtHours, projHref, taskName } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";

const PAGE_SIZE = 24;
type Season = "all" | "p1" | "p2" | "other";
type View = "grid" | "table";

function SeasonBadge({ v }: { v: DouyinVideo }) {
  if (v._season === "p2") return <span className="badge purple">Phần 2</span>;
  if (v._season === "p1") return <span className="badge amber">Phần 1</span>;
  return <span className="badge gray">Khác</span>;
}
const StatusBadge = ({ v }: { v: DouyinVideo }) => <span className={`badge ${STATUS_TONE[v._status]}`}>{STATUS_LABEL[v._status]}</span>;

function Cover({ v, className }: { v: DouyinVideo; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return v.cover_url ? <img className={className} src={v.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.remove()} /> : null;
}

function VideoDetail({ v, onClose }: { v: DouyinVideo; onClose: () => void }) {
  const toast = useToast();
  const pid = useProjectId();
  const { startTask, reload } = useStudio();
  const [status, setStatus] = useState(v.reup_status === "reupped" || v.reup_status === "downloaded" ? v.reup_status : "pending");
  const kv: [string, React.ReactNode][] = [
    ["Phần / Tập", <><SeasonBadge v={v} /> {v.episode_label ? `Tập ${v.episode_label}` : ""}</>],
    ["Ngày đăng", v.publish_date || "—"],
    ["Thời lượng", fmtDur(v.duration_sec) || "—"],
    ["Lượt thích", v.likes_raw || v.likes || 0],
    ["Bình luận", v.comments_raw || v.comments || 0],
    ["Lượt lưu", v.collects_raw || v.collects || 0],
    ["Chia sẻ", v.shares_raw || v.shares || 0],
    ["Mã video", <code key="c">{v.aweme_id}</code>],
    ["File đã tải", v.local_file ? <code key="f">downloads/{v.local_file}</code> : <span className="muted">Chưa tải</span>],
  ];
  return (
    <Modal title={epText(v)} onClose={onClose} size="wide">
      <div className="detail">
        <div>
          <div className="detail-media">
            {v.local_file ? <video src={douyinFileUrl(v.local_file)} controls /> : v.cover_url ? <Cover v={v} /> : <span className="muted">Không có ảnh bìa</span>}
          </div>
          <div className="actions">
            {v.local_file ? (
              <a className="btn btn-success" href={douyinFileUrl(v.local_file)} download>
                <Icon name="download" size={16} /> Lưu file MP4
              </a>
            ) : v.download_url ? (
              <button className="btn btn-primary" type="button" onClick={() => startTask("/api/download", { ids: v.aweme_id, project_id: pid }, "Đang tải video")}>
                <Icon name="download" size={16} /> Tải về máy
              </button>
            ) : null}
            {v.video_url && (
              <>
                <a className="btn btn-light" href={v.video_url} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={15} /> Mở trên Douyin
                </a>
                <button className="btn btn-quiet" type="button" onClick={() => copyText(v.video_url!, toast)}>
                  <Icon name="copy" size={15} /> Sao chép link
                </button>
              </>
            )}
          </div>
        </div>
        <div>
          <h4>{v.title}</h4>
          <dl className="kv">
            {kv.map(([k, val]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
          <div className="field">
            <label htmlFor="dt-status">Trạng thái reup</label>
            <select
              id="dt-status"
              className="select"
              value={status}
              onChange={async (e) => {
                const s = e.target.value;
                const d = await postJSON("/api/status", { key: videoKey(v), status: s });
                if (!d.ok) return toast(d.error || "Không lưu được trạng thái", "error");
                setStatus(s);
                toast(`Đã chuyển sang "${STATUS_LABEL[s]}"`, "success");
                reload();
              }}
            >
              <Options list={Object.entries(STATUS_LABEL)} />
            </select>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Pager({ page, pages, go }: { page: number; pages: number; go: (n: number) => void }) {
  if (pages <= 1) return null;
  const nums = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push(<span key={`g${n}`} className="gap">…</span>);
    out.push(
      <button key={n} type="button" className={n === page ? "active" : ""} onClick={() => go(n)}>
        {n}
      </button>
    );
    prev = n;
  }
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
        ‹ Trước
      </button>
      {out}
      <button type="button" disabled={page >= pages} onClick={() => go(page + 1)}>
        Sau ›
      </button>
    </div>
  );
}

function ListTab({ pid }: { pid: string }) {
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

  return (
    <>
      <div className="toolbar">
        <Seg<Season>
          value={f.season}
          onChange={(season) => upd({ season })}
          items={[
            { v: "all", label: "Tất cả ", count: c.all },
            { v: "p2", label: "Phần 2 ", count: c.p2 },
            { v: "p1", label: "Phần 1 ", count: c.p1 },
            { v: "other", label: "Video phụ ", count: c.other },
          ]}
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
      {!videos.length ? (
        <EmptyState icon="scan" title="Chưa có video nào" desc="Quét kênh Douyin để lấy danh sách video.">
          <Link className="btn btn-primary" href={projHref(pid, "douyin", "&tab=scan")}>
            Đi tới Quét kênh
          </Link>
        </EmptyState>
      ) : !list.length ? (
        <EmptyState icon="search" title="Không tìm thấy video phù hợp" desc="Thử đổi bộ lọc hoặc từ khóa tìm kiếm." />
      ) : f.view === "grid" ? (
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
      ) : (
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
      )}
      <Pager page={page} pages={pages} go={(n) => { setF({ ...f, page: n }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      {detail && <VideoDetail v={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function BatchTab({ pid }: { pid: string }) {
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
  const done = videos.filter((v) => v.local_file).sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));

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
                <Options list={[["p2", "Phần 2 — Tập 1 → 275 (liền mạch)"], ["p1", "Phần 1 — Tập 1 → 467 (thiếu 138–314)"], ["all", "Cả 2 phần"]]} />
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

function ScanTab() {
  const { videos, channel: m, douyinUpdatedAt, startTask } = useStudio();
  const [url, setUrl] = useState(DEFAULT_CHANNEL_URL);
  const total = Number(m.total_works || 0);
  const got = videos.length;
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
  const c = { p1: 0, p2: 0, other: 0 };
  videos.forEach((v) => c[v._season]++);
  const link = m.channel_url || m.share_url;
  return (
    <div className="cols cols-main-side">
      <div>
        <section className="card">
          <header className="card-head">
            <h3><span className="step-badge">1</span> Đăng nhập Douyin</h3>
            <span className="hint">Chỉ cần làm một lần</span>
          </header>
          <div className="card-body">
            <p className="lead">
              Douyin Web cần đăng nhập mới xem được danh sách video. Mở Chrome, đăng nhập bằng mã QR, rồi <b>đóng cửa sổ Chrome</b> để lưu phiên vào{" "}
              <code>chrome_profile/</code>.
            </p>
            <button className="btn btn-light" type="button" onClick={() => startTask("/api/login", { url: url.trim() }, "Đang mở Chrome để đăng nhập")}>
              <Icon name="key" size={16} /> Mở Chrome để đăng nhập
            </button>
          </div>
        </section>
        <section className="card">
          <header className="card-head">
            <h3><span className="step-badge">2</span> Quét danh sách video</h3>
          </header>
          <div className="card-body">
            <div className="field">
              <label htmlFor="scan-url">Link kênh Douyin</label>
              <input id="scan-url" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="actions">
              <button className="btn btn-primary" type="button" onClick={() => startTask("/api/scan", { url: url.trim(), resume: true }, "Bắt đầu quét nối tiếp")}>
                <Icon name="scan" size={16} /> Quét nối tiếp
              </button>
              <button className="btn btn-light" type="button"
                onClick={() => confirm("Quét lại từ đầu sẽ ghi đè dữ liệu cũ, kể cả trạng thái reup đã đánh dấu. Tiếp tục?") &&
                  startTask("/api/scan", { url: url.trim(), resume: false }, "Bắt đầu quét lại từ đầu")}>
                <Icon name="refresh" size={16} /> Quét lại từ đầu
              </button>
            </div>
            <Callout tone="info" icon="info">
              <b>Quét nối tiếp</b> giữ trạng thái reup đã đánh dấu, chỉ thêm video mới và làm mới link tải. Chrome sẽ tự mở và cuộn trang — đừng đóng nó cho tới
              khi quét xong.
            </Callout>
          </div>
        </section>
      </div>
      <aside>
        <section className="card">
          <header className="card-head"><h3>Kênh</h3></header>
          <div className="card-body">
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <div className="prog-meta">
              <span>Đã quét <b>{got}</b> / {total || "?"} video</span>
              <span>{pct}%</span>
            </div>
            <dl className="kv">
              <dt>Tên kênh</dt><dd>{m.channel_name || "—"}</dd>
              <dt>Douyin ID</dt><dd>{m.douyin_id || "—"}</dd>
              <dt>Cập nhật</dt><dd>{douyinUpdatedAt || "chưa quét"}</dd>
              <dt>Phần 2</dt><dd>{c.p2} video</dd>
              <dt>Phần 1</dt><dd>{c.p1} video</dd>
              <dt>Video phụ</dt><dd>{c.other} video</dd>
              <dt>Link</dt>
              <dd>
                {link ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    Mở trên Douyin <Icon name="external" size={13} />
                  </a>
                ) : "—"}
              </dd>
            </dl>
          </div>
        </section>
      </aside>
    </div>
  );
}

const TABS = [
  ["list", "Danh sách video", "Xem, lọc và đánh dấu trạng thái từng tập"],
  ["batch", "Tải theo tập", "Tải file MP4 gốc theo phần và khoảng tập"],
  ["scan", "Quét kênh", "Lấy danh sách video và link tải từ Douyin Web"],
] as const;

export default function DouyinPage() {
  const pid = useProjectId();
  const params = useSearchParams();
  const { task } = useStudio();
  const tab = TABS.find((t) => t[0] === params.get("tab")) || TABS[0];
  const busy = task?.running && (task.task_type === "scan_web" || task.task_type === "download");
  return (
    <>
      <ProjectTopbar title="Kho Douyin" sub={tab[2]} />
      <main className="content">
        <nav className="page-tabs" aria-label="Kho Douyin">
          {TABS.map(([k, label]) => (
            <Link key={k} href={projHref(pid, "douyin", `&tab=${k}`)} className={k === tab[0] ? "active" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        {busy && task && (
          <div className="inline-task">
            <b>
              <Icon name="download" size={16} /> {taskName(task.task_type)}
            </b>
            <ProgressBar task={task} />
          </div>
        )}
        {tab[0] === "list" && <ListTab pid={pid} />}
        {tab[0] === "batch" && <BatchTab pid={pid} />}
        {tab[0] === "scan" && <ScanTab />}
      </main>
    </>
  );
}
