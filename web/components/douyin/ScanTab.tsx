"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Callout } from "@/components/ui";
import { DEFAULT_CHANNEL_URL } from "@/lib/douyin";
import { useStudio } from "@/lib/studio";

export function ScanTab() {
  const { videos, channel: m, douyinUpdatedAt, startTask } = useStudio();
  const [url, setUrl] = useState(DEFAULT_CHANNEL_URL);
  const total = Number(m.total_works || 0);
  const got = videos.length;
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
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
