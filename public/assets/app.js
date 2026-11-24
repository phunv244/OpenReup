/* =========================================================
   Reup Studio — Ứng dụng 1 trang, nhiều trang con (hash router)
   ========================================================= */
"use strict";

const DEFAULT_CHANNEL_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";
const P2_START_TS = Math.floor(Date.parse("2026-02-16T00:00:00Z") / 1000);
const PAGE_SIZE = 24;

const state = {
  videos: [],
  meta: {},
  source: "",
  updatedAt: "",
  bili: [],
  dubbed: [],
  projects: [],
  activeProjectId: "",
  sources: [],
  sys: { free_gb: 0, total_gb: 0 },
  task: { running: false, task_type: "", logs: [] },
  loaded: false,
  vf: { season: "all", q: "", sort: "time_desc", status: "all", view: "grid", page: 1 },
  bf: { q: "" },
};

const SEASON_LABEL = { p1: "Phần 1", p2: "Phần 2", other: "Khác" };
const STATUS_LABEL = { pending: "Chưa reup", downloaded: "Đã tải", reupped: "Đã reup" };
const STATUS_TONE = { pending: "gray", downloaded: "green", reupped: "amber" };
const TASK_NAMES = {
  scan_web: "Quét kênh Douyin",
  download: "Tải video Douyin",
  bilibili_download: "Tải video Bilibili",
  bilibili_delogo: "Xóa logo video Bilibili",
  dub_video: "Dịch & Lồng tiếng Việt",
  dub_rerender: "Xuất lại bản lồng tiếng",
  login_chrome: "Đăng nhập Chrome",
};
const DELOGO_LABEL = {
  "top-right": "Đã xóa logo góc phải",
  "top-left": "Đã xóa logo góc trái",
  "both-top": "Đã xóa logo 2 góc",
  none: "Giữ nguyên",
};

/* ------------------------- Helpers ------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDur(sec) {
  sec = Math.round(Number(sec || 0));
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(mb) {
  mb = Number(mb || 0);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function dateOnly(s) {
  return (s || "").slice(0, 10) || "—";
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
function cnToInt(text) {
  let total = 0;
  let cur = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) cur = CN_DIGITS[ch];
    else if (ch in CN_UNITS) {
      total += (cur || 1) * CN_UNITS[ch];
      cur = 0;
    } else return null;
  }
  return total + cur || null;
}

function normalizeVideo(v) {
  const out = { ...v };
  // Sửa các tiêu đề thiếu chữ "集" (vd: 第一百零三：...)
  if (out.episode_num == null) {
    const m = (out.title || "").match(/^\s*(?:【[^】]*】)?\s*第([零〇一二两三四五六七八九十百千]+)[：:]/);
    if (m) {
      const n = cnToInt(m[1]);
      if (n) {
        out.episode_num = n;
        out.episode_label = String(n);
      }
    }
  }
  if (out.episode_num == null) out._season = "other";
  else out._season = (out.publish_time || 0) >= P2_START_TS ? "p2" : "p1";

  if (out.reup_status === "reupped") out._status = "reupped";
  else if (out.local_file || out.reup_status === "downloaded") out._status = "downloaded";
  else out._status = "pending";
  return out;
}

function videoKey(v) {
  return v.aweme_id || `${v.title}|${v.publish_date || ""}`;
}

function epText(v) {
  if (!v.episode_label) return v._season === "other" ? "Video phụ" : "—";
  return `${SEASON_LABEL[v._season] || ""} · Tập ${v.episode_label}`;
}

function seasonBadge(v) {
  if (v._season === "p2") return `<span class="badge purple">Phần 2</span>`;
  if (v._season === "p1") return `<span class="badge amber">Phần 1</span>`;
  return `<span class="badge gray">Khác</span>`;
}

function statusBadge(v) {
  return `<span class="badge ${STATUS_TONE[v._status]}">${STATUS_LABEL[v._status]}</span>`;
}

function toast(msg, type = "info") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add("hide"), 3400);
  setTimeout(() => el.remove(), 3800);
}

async function getJSON(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now());
  return res.json();
}

async function postJSON(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok && !data.error) data.error = `Lỗi máy chủ (HTTP ${res.status})`;
  return data;
}

function copyText(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast("Đã sao chép vào bộ nhớ tạm", "success"))
    .catch(() => toast("Không sao chép được, hãy copy thủ công", "error"));
}

/* ------------------------- Data loading ------------------------- */
async function loadVideos() {
  const d = await getJSON("/api/videos");
  state.videos = (d.videos || []).map(normalizeVideo);
  state.meta = d.channel_meta || {};
  state.source = d.source || "";
  state.updatedAt = d.updated_at || "";
}

async function loadBili() {
  const d = await getJSON("/api/bilibili");
  state.bili = d.videos || [];
}

async function loadSys() {
  try {
    state.sys = await getJSON("/api/system");
  } catch {}
}

async function loadDubs() {
  try {
    const [d1, d2, d3] = await Promise.all([getJSON("/api/dubbed"), getJSON("/api/sources"), getJSON("/api/projects")]);
    state.dubbed = d1.videos || [];
    state.sources = d2.sources || [];
    state.projects = d3.projects || [];
    if (!state.activeProjectId && state.projects.length) {
      state.activeProjectId = state.projects[0].id;
    }
  } catch {}
}

async function loadAll(showToast = false) {
  try {
    await Promise.all([loadVideos(), loadBili(), loadDubs(), loadSys()]);
    state.loaded = true;
    updateSidebarCounts();
    currentPage?.update?.();
    if (showToast) toast("Đã làm mới dữ liệu", "success");
  } catch (err) {
    console.error(err);
    toast("Không tải được dữ liệu từ máy chủ", "error");
  }
}

function updateSidebarCounts() {
  renderSidebar();
}

function getActiveProject() {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

function renderSidebar() {
  const nav = $("#sidebar-nav");
  if (!nav) return;
  const hash = location.hash.replace(/^#/, "") || "/projects";
  const projMatch = hash.match(/^\/project\/([^/]+)(?:\/(.*))?$/);
  const proj = projMatch ? state.projects.find((p) => p.id === projMatch[1]) || getActiveProject() : null;
  const sub = projMatch ? projMatch[2] || "dubbing" : "";

  if (projMatch && proj) {
    const base = `#/project/${proj.id}`;
    const projDubCount = (proj.videos || []).length;
    const dyDlCount = state.videos.filter((v) => v.local_file).length;
    nav.innerHTML = `
      <a class="sb-back" href="#/projects">← Tất cả dự án</a>
      <div class="sb-proj-box">
        <div class="sb-proj-label">Dự án đang mở</div>
        <div class="sb-proj-name" title="${esc(proj.name)}">📁 ${esc(proj.name)}</div>
      </div>

      <div class="nav-group">Dịch & Lồng tiếng AI</div>
      <a class="nav-link ${sub === "dubbing" ? "active" : ""}" href="${base}/dubbing">
        <span class="ico">🎙️</span><span>Dịch & Lồng tiếng</span>
        <span class="nav-count">${projDubCount}</span>
      </a>

      <div class="nav-group">Tải video Bilibili / YT</div>
      <a class="nav-link ${sub === "bilibili-new" ? "active" : ""}" href="${base}/bilibili-new">
        <span class="ico">➕</span><span>Tải video mới</span>
      </a>
      <a class="nav-link ${sub === "bilibili-library" ? "active" : ""}" href="${base}/bilibili-library">
        <span class="ico">🎬</span><span>Thư viện đã tải</span>
        <span class="nav-count">${state.bili.length}</span>
      </a>

      <div class="nav-group">Tải video Douyin</div>
      <a class="nav-link ${sub === "douyin-scan" ? "active" : ""}" href="${base}/douyin-scan">
        <span class="ico">🔍</span><span>Quét kênh</span>
      </a>
      <a class="nav-link ${sub === "douyin-videos" ? "active" : ""}" href="${base}/douyin-videos">
        <span class="ico">📋</span><span>Danh sách video</span>
        <span class="nav-count">${state.videos.length}</span>
      </a>
      <a class="nav-link ${sub === "douyin-downloads" ? "active" : ""}" href="${base}/douyin-downloads">
        <span class="ico">⬇️</span><span>Tải video</span>
        <span class="nav-count">${dyDlCount}</span>
      </a>

      <div class="nav-group">Cài đặt & Nhật ký</div>
      <a class="nav-link" href="javascript:void(0)" onclick="openProjectDrawer('${esc(proj.id)}')">
        <span class="ico">⚙️</span><span>Cài đặt dự án</span>
      </a>
      <a class="nav-link ${sub === "logs" ? "active" : ""}" href="${base}/logs">
        <span class="ico">📜</span><span>Nhật ký tiến trình</span>
      </a>`;
  } else {
    nav.innerHTML = `
      <div class="nav-group">Không gian làm việc</div>
      <a class="nav-link ${hash === "/projects" ? "active" : ""}" href="#/projects">
        <span class="ico">📁</span><span>Tất cả dự án</span>
        <span class="nav-count">${state.projects.length}</span>
      </a>
      <a class="nav-link ${hash === "/logs" ? "active" : ""}" href="#/logs">
        <span class="ico">📜</span><span>Nhật ký tiến trình</span>
      </a>
      <a class="nav-link ${hash === "/help" ? "active" : ""}" href="#/help">
        <span class="ico">❓</span><span>Hướng dẫn</span>
      </a>`;
  }
}

/* ------------------------- Task polling ------------------------- */
let lastRunning = false;
let pollTick = 0;

async function pollTask() {
  try {
    state.task = await getJSON("/api/task");
  } catch {
    return;
  }
  renderTaskWidgets();
  pollTick++;
  if (state.task.running && pollTick % 2 === 0) loadAll();
  if (lastRunning && !state.task.running) {
    loadAll();
    toast("Tiến trình đã kết thúc. Xem nhật ký để biết kết quả.", "success");
  }
  lastRunning = state.task.running;
}

function renderTaskWidgets() {
  const t = state.task || {};
  const name = TASK_NAMES[t.task_type] || t.task_type || "";

  $$(".js-task-status").forEach((el) => {
    el.classList.toggle("busy", !!t.running);
    el.classList.toggle("idle", !t.running);
    el.innerHTML = t.running
      ? `<span class="dot"></span><span>Đang chạy: <b>${esc(name)}</b></span>`
      : `<span class="dot"></span><span>Không có tiến trình nào đang chạy</span>`;
  });

  $$(".js-log").forEach((el) => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    const lines = t.logs || [];
    const limit = Number(el.dataset.limit || 0);
    const shown = limit ? lines.slice(-limit) : lines;
    el.textContent = shown.length
      ? shown.join("\n")
      : "Chưa có nhật ký. Khi bạn bấm quét hoặc tải, tiến trình sẽ hiện ở đây.";
    if (atBottom) el.scrollTop = el.scrollHeight;
  });

  $$(".js-busy-disable").forEach((el) => (el.disabled = !!t.running));
  $$(".js-stop").forEach((el) => (el.disabled = !t.running));

  // Update inline per-video progress bars right under the active video card
  $$(".js-vid-prog").forEach((box) => {
    const target = box.dataset.target || "";
    const job = box.dataset.job || "";
    const match = t.running && ((target && t.target === target) || (job && t.target === job));
    if (match) {
      const pct = Math.max(5, Math.min(100, Number(t.progress?.pct || 10)));
      const lbl = t.progress?.label || "Đang xử lý...";
      box.style.display = "block";
      box.innerHTML = `
        <div class="progress" style="height:7px"><div style="width:${pct}%"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--primary);margin-top:4px;font-weight:600">
          <span>⏳ ${esc(lbl)}</span><span>${pct}%</span>
        </div>`;
    } else {
      box.style.display = "none";
      box.innerHTML = "";
    }
  });

  // Inline download progress bar in the Bilibili quick-download card
  const dlBox = $("#ws-dl-prog");
  if (dlBox) {
    if (t.running && t.task_type === "bilibili_download") {
      const pct = Math.max(5, Math.min(100, Number(t.progress?.pct || 10)));
      const lbl = t.progress?.label || "Đang tải video...";
      dlBox.style.display = "block";
      dlBox.innerHTML = `
        <div class="progress" style="height:8px"><div style="width:${pct}%"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--pink);margin-top:5px;font-weight:600">
          <span>⬇ ${esc(lbl)}</span><span>${pct}%</span>
        </div>`;
    } else {
      dlBox.style.display = "none";
    }
  }
}

async function stopTask() {
  await postJSON("/api/task/stop");
  toast("Đã gửi lệnh dừng tiến trình");
  pollTask();
}

async function startTask(url, body, okMsg) {
  const d = await postJSON(url, body);
  if (!d.ok) {
    toast(d.error || "Không thể bắt đầu tiến trình", "error");
    return false;
  }
  toast(okMsg, "success");
  lastRunning = true;
  pollTask();
  return true;
}

/* ------------------------- Modal ------------------------- */
function openModal(title, bodyHtml, { wide = false } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-bg">
      <div class="modal ${wide ? "wide" : ""}">
        <div class="modal-head">
          <h3 title="${esc(title)}">${esc(title)}</h3>
          <button class="btn btn-light btn-sm" data-close>✕ Đóng</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const bg = root.firstElementChild;
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  function close() {
    $$("video", root).forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  }
  bg.addEventListener("click", (e) => {
    if (e.target === bg || e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  return { el: bg, close };
}

function douyinFileUrl(file) {
  return "/downloads/" + encodeURIComponent(file);
}
function biliFileUrl(file) {
  return "/downloads/bilibili/" + encodeURIComponent(file);
}
function dubFileUrl(file) {
  return "/downloads/dubbed/" + encodeURIComponent(file);
}

function openPlayer(src, title) {
  openModal(title, `<video class="player" src="${esc(src)}" controls autoplay></video>`, { wide: true });
}

/* ------------------------- Shared UI pieces ------------------------- */
function statCard(icon, label, value, sub, tone = "") {
  return `
    <div class="stat ${tone}">
      <div class="stat-ico">${icon}</div>
      <div>
        <div class="stat-label">${label}</div>
        <div class="stat-val">${value}</div>
        <div class="stat-sub">${sub}</div>
      </div>
    </div>`;
}

function logCard(title = "Nhật ký tiến trình", limit = 40, height = "") {
  return `
    <section class="card">
      <header class="card-head">
        <h3>📜 ${title}</h3>
        <button class="btn btn-danger btn-sm js-stop" onclick="stopTask()" disabled>⏹ Dừng</button>
      </header>
      <div class="card-body">
        <div class="task-status js-task-status idle"><span class="dot"></span> Đang kiểm tra...</div>
        <pre class="console js-log" data-limit="${limit}" ${height ? `style="height:${height}"` : ""}></pre>
      </div>
    </section>`;
}

function emptyState(icon, title, desc, actionHtml = "") {
  return `
    <div class="empty">
      <div class="e-ico">${icon}</div>
      <h4>${title}</h4>
      <p>${desc}</p>
      ${actionHtml}
    </div>`;
}

function thumbImg(url, alt = "") {
  return url
    ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : "";
}

/* =========================================================
   TRANG 1: TỔNG QUAN
   ========================================================= */
function PageDashboard() {
  return {
    render: () => `
      <div class="stats" id="dash-stats"></div>

      <div class="cols cols-2">
        <section class="card">
          <header class="card-head"><h3>🧭 Quy trình làm việc</h3><span class="hint">Làm lần lượt từ trên xuống</span></header>
          <div class="card-body">
            <ol class="steps">
              <li>
                <div class="step-num">1</div>
                <div>
                  <b>Quét kênh Douyin</b>
                  <p>Lấy danh sách toàn bộ video của kênh, kèm ảnh bìa và link tải.</p>
                  <a class="btn btn-light btn-sm" href="#/douyin/scan">Mở trang Quét kênh →</a>
                </div>
              </li>
              <li>
                <div class="step-num">2</div>
                <div>
                  <b>Xem & chọn video cần reup</b>
                  <p>Lọc theo Phần 1 / Phần 2, tìm theo số tập, đánh dấu trạng thái.</p>
                  <a class="btn btn-light btn-sm" href="#/douyin/videos">Mở Danh sách video →</a>
                </div>
              </li>
              <li>
                <div class="step-num">3</div>
                <div>
                  <b>Tải video Douyin về máy</b>
                  <p>Chọn phần và khoảng tập (vd: Tập 1 → 10) rồi tải hàng loạt.</p>
                  <a class="btn btn-light btn-sm" href="#/douyin/downloads">Mở trang Tải video →</a>
                </div>
              </li>
              <li>
                <div class="step-num pink">4</div>
                <div>
                  <b>Bổ sung tập thiếu từ Bilibili</b>
                  <p>Tập 138–314 không có trên Douyin: tải từ Bilibili và tự xóa logo.</p>
                  <a class="btn btn-light btn-sm" href="#/bilibili/new">Mở trang Bilibili →</a>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>⚙️ Tiến trình hiện tại</h3>
            <a href="#/logs">Xem nhật ký đầy đủ →</a>
          </header>
          <div class="card-body">
            <div class="task-status js-task-status idle"><span class="dot"></span> Đang kiểm tra...</div>
            <pre class="console js-log" data-limit="14" style="height:300px"></pre>
          </div>
        </section>
      </div>

      <section class="card">
        <header class="card-head">
          <h3>🆕 Tập mới nhất trên kênh Douyin</h3>
          <a href="#/douyin/videos">Xem tất cả →</a>
        </header>
        <div class="card-body p0" id="dash-latest"></div>
      </section>`,

    update() {
      const vids = state.videos;
      const total = state.meta.total_works || vids.length;
      const dl = vids.filter((v) => v.local_file).length;
      const reup = vids.filter((v) => v._status === "reupped").length;
      const biliSize = state.bili.reduce((a, v) => a + Number(v.size_mb || 0), 0);

      $("#dash-stats").innerHTML = [
        statCard("📋", "Video Douyin đã quét", `${vids.length}<span class="muted" style="font-size:15px"> / ${total}</span>`, `Cập nhật: ${esc(state.updatedAt || "chưa có")}`),
        statCard("⬇️", "Đã tải về (Douyin)", dl, "File MP4 trong thư mục downloads/", "green"),
        statCard("🎬", "Video Bilibili / YouTube", state.bili.length, `Tổng dung lượng ${fmtSize(biliSize)}`, "pink"),
        statCard("✅", "Đã reup", reup, `Còn ${vids.length - reup} video chưa reup`, "amber"),
      ].join("");

      const latest = [...vids]
        .filter((v) => v._season !== "other")
        .sort((a, b) => (b.publish_time || 0) - (a.publish_time || 0))
        .slice(0, 6);

      $("#dash-latest").innerHTML = latest.length
        ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Ảnh</th><th>Phần / Tập</th><th>Tiêu đề</th><th>Ngày đăng</th><th>Thời lượng</th><th>Trạng thái</th></tr></thead>
            <tbody>${latest.map((v) => `
              <tr class="clickable" data-id="${esc(v.aweme_id)}">
                <td>${v.cover_url ? `<img class="thumb" src="${esc(v.cover_url)}" referrerpolicy="no-referrer" loading="lazy" />` : ""}</td>
                <td class="nowrap">${seasonBadge(v)} <b>Tập ${esc(v.episode_label)}</b></td>
                <td class="title-cell">${esc(v.title)}</td>
                <td class="nowrap">${dateOnly(v.publish_date)}</td>
                <td>${fmtDur(v.duration_sec) || "—"}</td>
                <td>${statusBadge(v)}</td>
              </tr>`).join("")}
            </tbody></table></div>`
        : `<div style="padding:18px">${emptyState("📭", "Chưa có dữ liệu", "Hãy quét kênh Douyin trước.", `<a class="btn btn-primary" href="#/douyin/scan">Quét kênh ngay</a>`)}</div>`;
    },

    mount() {
      $("#dash-latest").addEventListener("click", (e) => {
        const row = e.target.closest("[data-id]");
        if (row) openVideoDetail(row.dataset.id);
      });
    },
  };
}

/* =========================================================
   TRANG 2: QUÉT KÊNH DOUYIN
   ========================================================= */
function PageScan() {
  return {
    render: () => `
      <div class="cols cols-main-side">
        <div>
          <section class="card">
            <header class="card-head">
              <h3><span class="step-badge">Bước 1</span> Đăng nhập Douyin</h3>
              <span class="hint">Chỉ cần làm 1 lần</span>
            </header>
            <div class="card-body">
              <p style="margin:0 0 14px;color:var(--text-2)">
                Douyin Web cần đăng nhập mới cho xem danh sách video. Bấm nút dưới để mở cửa sổ Chrome,
                đăng nhập bằng mã QR, sau đó <b>đóng cửa sổ Chrome</b> để lưu phiên.
              </p>
              <button class="btn btn-light js-busy-disable" id="btn-login">🔑 Mở Chrome để đăng nhập</button>
              <div class="callout ok"><span class="ci">✅</span><span>Phiên đăng nhập được lưu trong thư mục <code>chrome_profile/</code>. Nếu bạn đã đăng nhập trước đó thì có thể bỏ qua bước này.</span></div>
            </div>
          </section>

          <section class="card">
            <header class="card-head">
              <h3><span class="step-badge">Bước 2</span> Quét danh sách video</h3>
            </header>
            <div class="card-body">
              <div class="field">
                <label for="scan-url">Link kênh Douyin</label>
                <input id="scan-url" class="input" type="text" value="${esc(DEFAULT_CHANNEL_URL)}" />
                <div class="help">Dạng <code>https://www.douyin.com/user/...</code> — mặc định là kênh 楚新钓.</div>
              </div>
              <div class="actions">
                <button class="btn btn-primary js-busy-disable" id="btn-scan-resume">➕ Quét nối tiếp (giữ dữ liệu cũ)</button>
                <button class="btn btn-light js-busy-disable" id="btn-scan-new">🔄 Quét lại từ đầu</button>
              </div>
              <div class="callout info">
                <span class="ci">💡</span>
                <span><b>Nên dùng "Quét nối tiếp"</b>: giữ lại trạng thái reup đã đánh dấu, chỉ bổ sung video mới và làm mới link tải.
                Một cửa sổ Chrome sẽ tự mở và cuộn trang — <b>đừng đóng nó</b> cho tới khi quét xong. Mạng chậm thì sẽ lâu hơn, cứ để tool chạy.</span>
              </div>
            </div>
          </section>

          ${logCard("Nhật ký quét", 60)}
        </div>

        <aside>
          <section class="card">
            <header class="card-head"><h3>📺 Thông tin kênh</h3></header>
            <div class="card-body" id="scan-channel"></div>
          </section>
          <section class="card">
            <header class="card-head"><h3>📊 Tiến độ quét</h3></header>
            <div class="card-body" id="scan-progress"></div>
          </section>
          <section class="card">
            <header class="card-head"><h3>🗂️ Phân loại nội dung</h3></header>
            <div class="card-body" id="scan-breakdown"></div>
          </section>
        </aside>
      </div>`,

    mount() {
      $("#btn-login").onclick = () =>
        startTask("/api/login", { url: $("#scan-url").value.trim() }, "Đang mở Chrome để đăng nhập...");
      $("#btn-scan-resume").onclick = () =>
        startTask("/api/scan", { url: $("#scan-url").value.trim(), resume: true }, "Bắt đầu quét nối tiếp...");
      $("#btn-scan-new").onclick = () => {
        if (!confirm("Quét lại từ đầu sẽ ghi đè dữ liệu cũ (kể cả trạng thái reup đã đánh dấu). Tiếp tục?")) return;
        startTask("/api/scan", { url: $("#scan-url").value.trim(), resume: false }, "Bắt đầu quét lại từ đầu...");
      };
    },

    update() {
      const m = state.meta;
      const total = Number(m.total_works || 0);
      const got = state.videos.length;
      $("#scan-channel").innerHTML = `
        <dl class="kv">
          <dt>Tên kênh</dt><dd>${esc(m.channel_name || "—")}</dd>
          <dt>Douyin ID</dt><dd>${esc(m.douyin_id || "—")}</dd>
          <dt>Tổng tác phẩm</dt><dd>${esc(m.total_works || "—")}</dd>
          <dt>Nguồn dữ liệu</dt><dd>${esc(state.source || "—")}</dd>
          <dt>Cập nhật lúc</dt><dd>${esc(state.updatedAt || "—")}</dd>
          <dt>Link kênh</dt><dd>${m.channel_url || m.share_url ? `<a href="${esc(m.channel_url || m.share_url)}" target="_blank">Mở trên Douyin ↗</a>` : "—"}</dd>
        </dl>`;

      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
      $("#scan-progress").innerHTML = `
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="progress-meta"><span><b>${got}</b> / ${total || "?"} video</span><span>${pct}%</span></div>
        ${pct >= 100 ? `<div class="callout ok"><span class="ci">🎉</span><span>Đã quét đủ toàn bộ video của kênh.</span></div>` : ""}`;

      const c = { p1: 0, p2: 0, other: 0 };
      state.videos.forEach((v) => c[v._season]++);
      $("#scan-breakdown").innerHTML = `
        <dl class="kv">
          <dt>${seasonBadge({ _season: "p2" })}</dt><dd>${c.p2} video <span class="muted">(Tập 1 → 275, liền mạch)</span></dd>
          <dt>${seasonBadge({ _season: "p1" })}</dt><dd>${c.p1} video <span class="muted">(thiếu Tập 138–314)</span></dd>
          <dt>${seasonBadge({ _season: "other" })}</dt><dd>${c.other} video <span class="muted">(live, quảng cáo)</span></dd>
        </dl>`;
    },
  };
}

/* =========================================================
   TRANG 3: DANH SÁCH VIDEO DOUYIN
   ========================================================= */
function PageVideos() {
  function filtered() {
    const f = state.vf;
    const q = f.q.trim().toLowerCase();
    const list = state.videos.filter((v) => {
      if (f.season !== "all" && v._season !== f.season) return false;
      if (f.status !== "all" && v._status !== f.status) return false;
      if (!q) return true;
      return (
        (v.title || "").toLowerCase().includes(q) ||
        String(v.episode_label || "") === q ||
        (v.publish_date || "").includes(q) ||
        (v.aweme_id || "").includes(q)
      );
    });
    const byTime = (a, b) => (a.publish_time || 0) - (b.publish_time || 0);
    const sorters = {
      time_desc: (a, b) => -byTime(a, b),
      time_asc: byTime,
      ep_asc: (a, b) => (a.episode_num ?? 1e9) - (b.episode_num ?? 1e9) || byTime(a, b),
      ep_desc: (a, b) => (b.episode_num ?? -1) - (a.episode_num ?? -1) || -byTime(a, b),
      likes_desc: (a, b) => (b.likes || 0) - (a.likes || 0),
    };
    return list.sort(sorters[f.sort] || sorters.time_desc);
  }

  function gridHtml(items) {
    return `<div class="vgrid">${items.map((v) => `
      <article class="vcard" data-id="${esc(v.aweme_id)}">
        <div class="vthumb">
          ${thumbImg(v.cover_url, v.title) || "Không có ảnh bìa"}
          <div class="tl">${v.episode_label ? `<span class="ov">Tập ${esc(v.episode_label)}</span>` : ""}</div>
          <div class="tr">${v._season === "p2" ? `<span class="ov purple">P2</span>` : v._season === "p1" ? `<span class="ov amber">P1</span>` : `<span class="ov">Khác</span>`}</div>
          <div class="bl">${v.local_file ? `<span class="ov green">✓ Đã tải</span>` : ""}</div>
          <div class="br">${v.duration_sec ? `<span class="ov">${fmtDur(v.duration_sec)}</span>` : ""}</div>
        </div>
        <div class="vbody">
          <div class="vtitle" title="${esc(v.title)}">${esc(v.title)}</div>
          <div class="vmeta">
            <span>📅 ${dateOnly(v.publish_date)}</span>
            <span>♥ ${esc(v.likes_raw || v.likes || 0)}</span>
          </div>
          <div class="vmeta">${statusBadge(v)}<span class="muted">Bấm để xem chi tiết</span></div>
        </div>
      </article>`).join("")}</div>`;
  }

  function tableHtml(items, offset) {
    return `<section class="card"><div class="table-wrap"><table class="tbl">
      <thead><tr><th>#</th><th>Ảnh</th><th>Phần / Tập</th><th>Tiêu đề</th><th>Ngày đăng</th><th>Thời lượng</th><th>Thích</th><th>Trạng thái</th></tr></thead>
      <tbody>${items.map((v, i) => `
        <tr class="clickable" data-id="${esc(v.aweme_id)}">
          <td class="muted">${offset + i + 1}</td>
          <td>${v.cover_url ? `<img class="thumb" src="${esc(v.cover_url)}" referrerpolicy="no-referrer" loading="lazy" />` : ""}</td>
          <td class="nowrap">${seasonBadge(v)} ${v.episode_label ? `<b>Tập ${esc(v.episode_label)}</b>` : ""}</td>
          <td class="title-cell">${esc(v.title)}</td>
          <td class="nowrap">${dateOnly(v.publish_date)}</td>
          <td>${fmtDur(v.duration_sec) || "—"}</td>
          <td class="nowrap">${esc(v.likes_raw || v.likes || 0)}</td>
          <td>${statusBadge(v)}</td>
        </tr>`).join("")}
      </tbody></table></div></section>`;
  }

  function pagerHtml(page, pages) {
    if (pages <= 1) return "";
    const nums = new Set([1, pages, page - 1, page, page + 1, page - 2, page + 2]);
    const list = [...nums].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    let html = `<button data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ Trước</button>`;
    let prev = 0;
    for (const n of list) {
      if (n - prev > 1) html += `<span class="gap">…</span>`;
      html += `<button data-page="${n}" class="${n === page ? "active" : ""}">${n}</button>`;
      prev = n;
    }
    html += `<button data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Sau ›</button>`;
    return html;
  }

  function draw() {
    const items = filtered();
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (state.vf.page > pages) state.vf.page = pages;
    const page = state.vf.page;
    const start = (page - 1) * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);

    $("#vf-meta").innerHTML = `
      <span>Hiển thị <b>${items.length ? start + 1 : 0}–${start + slice.length}</b> trong <b>${items.length}</b> video</span>
      <span class="muted">Trang ${page} / ${pages}</span>`;

    $("#vf-list").innerHTML = !state.videos.length
      ? emptyState("📭", "Chưa có video nào", "Bạn cần quét kênh Douyin trước.", `<a class="btn btn-primary" href="#/douyin/scan">Đi tới Quét kênh</a>`)
      : !items.length
        ? emptyState("🔎", "Không tìm thấy video phù hợp", "Thử đổi bộ lọc hoặc từ khóa tìm kiếm.")
        : state.vf.view === "grid"
          ? gridHtml(slice)
          : tableHtml(slice, start);

    $("#vf-pager").innerHTML = pagerHtml(page, pages);

    const c = { all: state.videos.length, p1: 0, p2: 0, other: 0 };
    state.videos.forEach((v) => c[v._season]++);
    Object.entries(c).forEach(([k, n]) => {
      const el = $(`#vf-season [data-v="${k}"] .cnt`);
      if (el) el.textContent = n;
    });
  }

  function setSeg(id, val) {
    $$(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset.v === val));
  }

  return {
    render: () => `
      <section class="card">
        <div class="card-body">
          <div class="toolbar">
            <span class="label" style="margin:0 6px 0 0">Phần:</span>
            <div class="seg" id="vf-season">
              <button data-v="all">Tất cả <span class="cnt">0</span></button>
              <button data-v="p2">🔥 Phần 2 <span class="cnt">0</span></button>
              <button data-v="p1">📜 Phần 1 <span class="cnt">0</span></button>
              <button data-v="other">📢 Video phụ <span class="cnt">0</span></button>
            </div>
          </div>
          <div class="toolbar">
            <input id="vf-q" class="input" type="search" placeholder="🔍  Tìm theo tên, số tập (vd: 25), ngày (vd: 2026-03)..." />
            <select id="vf-sort" class="select">
              <option value="time_desc">Mới đăng nhất trước</option>
              <option value="time_asc">Cũ nhất trước (đúng mạch truyện)</option>
              <option value="ep_asc">Số tập: nhỏ → lớn</option>
              <option value="ep_desc">Số tập: lớn → nhỏ</option>
              <option value="likes_desc">Nhiều lượt thích nhất</option>
            </select>
            <select id="vf-status" class="select">
              <option value="all">Mọi trạng thái</option>
              <option value="pending">Chưa reup</option>
              <option value="downloaded">Đã tải</option>
              <option value="reupped">Đã reup</option>
            </select>
            <div class="seg" id="vf-view">
              <button data-v="grid">▦ Thẻ</button>
              <button data-v="table">☰ Bảng</button>
            </div>
          </div>
        </div>
      </section>
      <div class="list-meta" id="vf-meta"></div>
      <div id="vf-list"></div>
      <div class="pager" id="vf-pager"></div>`,

    mount() {
      const f = state.vf;
      $("#vf-q").value = f.q;
      $("#vf-sort").value = f.sort;
      $("#vf-status").value = f.status;
      setSeg("vf-season", f.season);
      setSeg("vf-view", f.view);

      $("#vf-season").onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        f.season = b.dataset.v;
        f.page = 1;
        setSeg("vf-season", f.season);
        draw();
      };
      $("#vf-view").onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        f.view = b.dataset.v;
        setSeg("vf-view", f.view);
        draw();
      };
      let qTimer;
      $("#vf-q").oninput = (e) => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => {
          f.q = e.target.value;
          f.page = 1;
          draw();
        }, 200);
      };
      $("#vf-sort").onchange = (e) => {
        f.sort = e.target.value;
        f.page = 1;
        draw();
      };
      $("#vf-status").onchange = (e) => {
        f.status = e.target.value;
        f.page = 1;
        draw();
      };
      $("#vf-list").onclick = (e) => {
        const el = e.target.closest("[data-id]");
        if (el) openVideoDetail(el.dataset.id);
      };
      $("#vf-pager").onclick = (e) => {
        const b = e.target.closest("button[data-page]");
        if (!b || b.disabled) return;
        f.page = Number(b.dataset.page);
        draw();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    },

    update: draw,
  };
}

/* ---------- Popup chi tiết 1 video Douyin ---------- */
function openVideoDetail(awemeId) {
  const v = state.videos.find((x) => String(x.aweme_id) === String(awemeId));
  if (!v) return;
  const media = v.local_file
    ? `<video src="${esc(douyinFileUrl(v.local_file))}" controls></video>`
    : thumbImg(v.cover_url, v.title) || "Không có ảnh bìa";

  const html = `
    <div class="detail">
      <div>
        <div class="detail-media">${media}</div>
        <div class="actions" style="margin-top:14px">
          ${v.local_file
            ? `<a class="btn btn-success" href="${esc(douyinFileUrl(v.local_file))}" download>💾 Lưu file MP4</a>`
            : v.download_url
              ? `<button class="btn btn-primary js-busy-disable" id="dt-download">⬇ Tải MP4 về máy</button>`
              : ""}
          ${v.video_url ? `<a class="btn btn-light" href="${esc(v.video_url)}" target="_blank">Mở trên Douyin ↗</a>` : ""}
          ${v.video_url ? `<button class="btn btn-ghost" id="dt-copy">📋 Sao chép link</button>` : ""}
        </div>
      </div>
      <div>
        <h4>${esc(v.title)}</h4>
        <dl class="kv">
          <dt>Phần / Tập</dt><dd>${seasonBadge(v)} ${v.episode_label ? `Tập ${esc(v.episode_label)}` : ""}</dd>
          <dt>Ngày đăng</dt><dd>${esc(v.publish_date || "—")}</dd>
          <dt>Thời lượng</dt><dd>${fmtDur(v.duration_sec) || "—"}</dd>
          <dt>Lượt thích</dt><dd>${esc(v.likes_raw || v.likes || 0)}</dd>
          <dt>Bình luận</dt><dd>${esc(v.comments_raw || v.comments || 0)}</dd>
          <dt>Lượt lưu</dt><dd>${esc(v.collects_raw || v.collects || 0)}</dd>
          <dt>Chia sẻ</dt><dd>${esc(v.shares_raw || v.shares || 0)}</dd>
          <dt>Mã video</dt><dd><code>${esc(v.aweme_id)}</code></dd>
          <dt>File đã tải</dt><dd>${v.local_file ? `<code>downloads/${esc(v.local_file)}</code>` : `<span class="muted">Chưa tải</span>`}</dd>
        </dl>
        <div class="field" style="margin-top:18px">
          <label for="dt-status">Trạng thái reup</label>
          <select id="dt-status" class="select">
            <option value="pending">Chưa reup</option>
            <option value="downloaded">Đã tải</option>
            <option value="reupped">Đã reup</option>
          </select>
          <div class="help">Đánh dấu để dễ theo dõi tập nào đã đăng lại.</div>
        </div>
      </div>
    </div>`;

  const { el } = openModal(epText(v), html, { wide: true });
  renderTaskWidgets();

  const sel = $("#dt-status", el);
  sel.value = v.reup_status === "reupped" ? "reupped" : v.reup_status === "downloaded" ? "downloaded" : "pending";
  sel.onchange = async () => {
    const d = await postJSON("/api/status", { key: videoKey(v), status: sel.value });
    if (d.ok) {
      toast(`Đã chuyển sang "${STATUS_LABEL[sel.value]}"`, "success");
      loadAll();
    } else toast(d.error || "Không lưu được trạng thái", "error");
  };
  const dlBtn = $("#dt-download", el);
  if (dlBtn) dlBtn.onclick = () => startTask("/api/download", { ids: v.aweme_id }, "Đang tải video, xem tiến trình ở thanh bên trái");
  const cpBtn = $("#dt-copy", el);
  if (cpBtn) cpBtn.onclick = () => copyText(v.video_url);
}

/* =========================================================
   TRANG 4: TẢI VIDEO DOUYIN
   ========================================================= */
function PageDouyinDownloads() {
  function selection() {
    const season = $("#dl-season").value;
    const from = Number($("#dl-from").value || 0);
    const to = Number($("#dl-to").value || 0);
    const skip = $("#dl-skip").checked;
    return state.videos
      .filter((v) => (season === "all" ? v._season !== "other" : v._season === season))
      .filter((v) => v.episode_num != null && v.episode_num >= from && v.episode_num <= to)
      .filter((v) => v.download_url)
      .filter((v) => !(skip && v.local_file))
      .sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
  }

  function drawPreview() {
    const sel = selection();
    const dur = sel.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
    $("#dl-preview").innerHTML = sel.length
      ? `<span class="ci">📦</span><span>Sẽ tải <b>${sel.length} video</b> (tổng thời lượng khoảng <b>${fmtDur(dur)}</b>).
         Từ "<i>${esc(sel[0].title.slice(0, 40))}…</i>" đến "<i>${esc(sel[sel.length - 1].title.slice(0, 40))}…</i>"</span>`
      : `<span class="ci">ℹ️</span><span>Không có video nào khớp. Hãy kiểm tra lại phần và khoảng tập.</span>`;
    $("#dl-preview").className = "callout " + (sel.length ? "info" : "warn");
    $("#dl-start").disabled = !sel.length || state.task.running;
  }

  function drawDone() {
    const done = state.videos
      .filter((v) => v.local_file)
      .sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
    $("#dl-done-count").textContent = done.length;
    $("#dl-done").innerHTML = done.length
      ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Phần / Tập</th><th>Tiêu đề</th><th>Thời lượng</th><th>File</th><th></th></tr></thead>
          <tbody>${done.map((v) => `
            <tr>
              <td class="nowrap">${seasonBadge(v)} ${v.episode_label ? `<b>Tập ${esc(v.episode_label)}</b>` : ""}</td>
              <td class="title-cell">${esc(v.title)}</td>
              <td>${fmtDur(v.duration_sec) || "—"}</td>
              <td><code style="font-size:11.5px">${esc(v.local_file.slice(0, 32))}…</code></td>
              <td class="nowrap">
                <button class="btn btn-success btn-sm" data-play="${esc(v.local_file)}" data-title="${esc(v.title)}">▶ Xem</button>
                <a class="btn btn-light btn-sm" href="${esc(douyinFileUrl(v.local_file))}" download>💾 Lưu</a>
              </td>
            </tr>`).join("")}
          </tbody></table></div>`
      : `<div style="padding:18px">${emptyState("📂", "Chưa tải video nào", "Chọn phần và khoảng tập ở trên rồi bấm Bắt đầu tải.")}</div>`;
  }

  return {
    render: () => `
      <div class="cols cols-main-side">
        <div>
          <section class="card">
            <header class="card-head"><h3>⬇️ Tải hàng loạt theo tập</h3><span class="hint">Video MP4 gốc từ Douyin</span></header>
            <div class="card-body">
              <div class="field">
                <label for="dl-season">1. Chọn phần</label>
                <select id="dl-season" class="select">
                  <option value="p2">🔥 Phần 2 — Tập 1 đến 275 (liền mạch, khuyên dùng)</option>
                  <option value="p1">📜 Phần 1 — Tập 1 đến 467 (thiếu Tập 138–314)</option>
                  <option value="all">Cả 2 phần</option>
                </select>
              </div>
              <div class="field">
                <span class="label">2. Chọn khoảng tập</span>
                <div class="row">
                  <div class="w-sm"><input id="dl-from" class="input" type="number" min="1" value="1" /><div class="help">Từ tập</div></div>
                  <div class="w-sm"><input id="dl-to" class="input" type="number" min="1" value="10" /><div class="help">Đến tập</div></div>
                  <div class="grow" style="padding-bottom:22px">
                    <label class="check"><input id="dl-skip" type="checkbox" checked /> Bỏ qua các tập đã tải</label>
                  </div>
                </div>
              </div>
              <div id="dl-preview" class="callout info"></div>
            </div>
            <div class="card-foot">
              <button class="btn btn-primary btn-lg js-busy-disable" id="dl-start">⬇ Bắt đầu tải</button>
              <span class="muted" style="font-size:12.5px">Theo dõi tiến trình ở khung nhật ký bên phải.</span>
            </div>
          </section>

          <section class="card">
            <header class="card-head"><h3>📂 Video đã tải về máy <span class="badge green" id="dl-done-count">0</span></h3></header>
            <div class="card-body p0" id="dl-done"></div>
          </section>
        </div>

        <aside>
          ${logCard("Nhật ký tải", 40, "320px")}
          <section class="card">
            <header class="card-head"><h3>ℹ️ Lưu ý</h3></header>
            <div class="card-body prose">
              <p>📁 File được lưu tại <code>downloads/</code> với tên dạng <code>Ep001_&lt;mã&gt;_&lt;tiêu đề&gt;.mp4</code>.</p>
              <p>⏰ Link tải của Douyin <b>có hạn sử dụng</b>. Nếu bị lỗi <code>403</code>, hãy vào
                <a href="#/douyin/scan">Quét kênh</a> và bấm <b>Quét nối tiếp</b> để làm mới link, rồi tải lại.</p>
            </div>
          </section>
        </aside>
      </div>`,

    mount() {
      ["dl-season", "dl-from", "dl-to", "dl-skip"].forEach((id) => {
        $("#" + id).addEventListener("input", drawPreview);
        $("#" + id).addEventListener("change", drawPreview);
      });
      $("#dl-start").onclick = () => {
        const sel = selection();
        if (!sel.length) return;
        startTask("/api/download", { ids: sel.map((v) => v.aweme_id).join(",") }, `Bắt đầu tải ${sel.length} video...`);
      };
      $("#dl-done").onclick = (e) => {
        const b = e.target.closest("[data-play]");
        if (b) openPlayer(douyinFileUrl(b.dataset.play), b.dataset.title);
      };
    },

    update() {
      drawPreview();
      drawDone();
    },
  };
}

/* =========================================================
   TRANG 5: TẢI VIDEO BILIBILI / YOUTUBE
   ========================================================= */
function PageBiliNew() {
  const presets = [
    { label: "Tập 151–200 (hợp tuyển Full HD, ~5 tiếng)", url: "https://www.bilibili.com/video/BV1teKEzeEfZ/" },
    { label: "Tập lẻ 楚新钓 (84 giây, test nhanh)", url: "https://www.bilibili.com/video/BV1nHW3z3EhH/" },
  ];
  const options = [
    { v: "top-right", title: "Góc trên bên phải", desc: "Thường gặp ở video ngang", marks: ["r"] },
    { v: "top-left", title: "Góc trên bên trái", desc: "Thường gặp ở video dọc", marks: ["l"] },
    { v: "both-top", title: "Cả 2 góc trên", desc: "Khi không chắc vị trí logo", marks: ["l", "r"] },
    { v: "none", title: "Tải trước, xóa sau", desc: "Nhẹ máy nhất cho video dài", marks: [] },
  ];

  function drawRecent() {
    const diskEl = $("#bl-disk");
    if (diskEl && state.sys.free_gb) {
      diskEl.innerHTML = `💾 Ổ cứng trống: <b>${state.sys.free_gb} GB</b> / ${state.sys.total_gb} GB`;
    }
    const recent = state.bili.slice(0, 4);
    $("#bl-recent").innerHTML = recent.length
      ? `<div class="mini-list">${recent.map((v) => `
          <div class="mini-item">
            <video class="ph" src="${esc(biliFileUrl(v.local_file))}#t=2" preload="metadata" muted playsinline style="object-fit:cover"></video>
            <div class="mi-body">
              <div class="mi-title" title="${esc(v.title)}">${esc(v.title)}</div>
              <div class="mi-sub">${esc(v.resolution || "")} · ${fmtDur(v.duration_sec)} · ${fmtSize(v.size_mb)}</div>
            </div>
            <button class="btn btn-success btn-sm" data-play="${esc(v.local_file)}" data-title="${esc(v.title)}">▶</button>
          </div>`).join("")}</div>`
      : `<div style="padding:18px" class="muted">Chưa có video nào.</div>`;
  }

  return {
    render: () => `
      <div class="cols cols-main-side">
        <div>
          <section class="card">
            <header class="card-head">
              <h3><span class="step-badge pink">1</span> Dán link & chọn đoạn cần tải</h3>
              <span class="hint" id="bl-disk"></span>
            </header>
            <div class="card-body">
              <div class="field">
                <label for="bl-url">Link Bilibili hoặc YouTube</label>
                <input id="bl-url" class="input" type="text" placeholder="https://www.bilibili.com/video/BV..." />
                <div class="help">Tự động nối tiếp khi rớt mạng (<code>--continue</code>) & kiểm tra dung lượng ổ cứng trước khi tải.</div>
              </div>
              <div class="label" style="margin-top:4px">Link có sẵn (bấm để điền):</div>
              <div class="chips" style="margin-bottom:16px">
                ${presets.map((p) => `<button class="chip" type="button" data-url="${esc(p.url)}">⚡ ${esc(p.label)}</button>`).join("")}
              </div>

              <div class="cols cols-2" style="gap:14px">
                <div class="field" style="margin:0;padding:12px;border:1px solid var(--border);border-radius:10px;background:#fafbfd">
                  <label>✂️ Cắt theo khung giờ (cho video gộp dài 5h–90h)</label>
                  <div class="row" style="gap:8px;align-items:center">
                    <input id="bl-from" class="input" style="width:115px" type="text" placeholder="00:00:00" />
                    <span class="muted">→</span>
                    <input id="bl-to" class="input" style="width:115px" type="text" placeholder="01:00:00" />
                  </div>
                  <div class="chips" style="margin-top:8px">
                    <button class="chip" type="button" data-sec="00:00:00,00:15:00">15 phút đầu</button>
                    <button class="chip" type="button" data-sec="00:00:00,01:00:00">Giờ thứ 1</button>
                    <button class="chip" type="button" data-sec="01:00:00,02:00:00">Giờ thứ 2</button>
                    <button class="chip" type="button" data-sec=",">Lấy trọn video</button>
                  </div>
                  <div class="help">Để trống nếu muốn tải trọn vẹn cả video.</div>
                </div>

                <div class="field" style="margin:0;padding:12px;border:1px solid var(--border);border-radius:10px;background:#fafbfd">
                  <label for="bl-pitems">📑 Chọn Part (cho link nhiều phần P1, P2...)</label>
                  <input id="bl-pitems" class="input" type="text" placeholder="Ví dụ: 1-5 hoặc 1,3,5" />
                  <div style="margin-top:10px">
                    <label class="check"><input id="bl-playlist" type="checkbox" /> Tải toàn bộ mọi Part trong playlist</label>
                  </div>
                  <div class="help">Nên tải từng đợt 5–10 Part để tránh đầy ổ cứng.</div>
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <header class="card-head">
              <h3><span class="step-badge pink">2</span> Chọn cách xử lý logo</h3>
              <span class="hint">Có thể tải trước rồi xóa logo sau trong Thư viện</span>
            </header>
            <div class="card-body">
              <div class="opt-grid" id="bl-delogo">
                ${options.map((o, i) => `
                  <label class="opt ${i === 0 ? "checked" : ""}">
                    <input type="radio" name="delogo" value="${o.v}" ${i === 0 ? "checked" : ""} />
                    <div class="screen">${o.marks.map((m) => `<span class="mark ${m}"></span>`).join("")}</div>
                    <div class="opt-title">${o.title}</div>
                    <div class="opt-desc">${o.desc}</div>
                  </label>`).join("")}
              </div>
              <div class="callout info"><span class="ci">💡</span><span><b>Mẹo giảm tải:</b> Với video dài hàng chục tiếng, hãy chọn <b>"Tải trước, xóa sau"</b> (CPU chỉ ~5%). Sau khi tải xong bạn vào <b>Thư viện đã tải</b> bấm <b>✨ Xóa logo</b> lúc nào cũng được!</span></div>
            </div>
          </section>

          <section class="card">
            <header class="card-head"><h3><span class="step-badge pink">3</span> Chất lượng & Mức tải hệ thống</h3></header>
            <div class="card-body">
              <div class="cols cols-2" style="gap:14px">
                <div class="field" style="margin:0">
                  <label for="bl-quality">Độ phân giải</label>
                  <select id="bl-quality" class="select">
                    <option value="best">Cao nhất (1080p trở lên)</option>
                    <option value="720p">Tối đa 720p (giảm 50% dung lượng, rất hợp hoạt hình)</option>
                  </select>
                </div>
                <div class="field" style="margin:0">
                  <label for="bl-perf">Chế độ hiệu năng khi xóa logo</label>
                  <select id="bl-perf" class="select">
                    <option value="balanced">⚖️ Cân bằng — Tự nhận GPU / giới hạn 50% CPU (khuyên dùng)</option>
                    <option value="eco">🌿 Mát máy — Chỉ dùng 30% CPU, chạy nền êm</option>
                    <option value="fast">🚀 Tốc độ tối đa — Bung hết công suất máy</option>
                  </select>
                </div>
              </div>
            </div>
            <div class="card-foot">
              <button class="btn btn-pink btn-lg js-busy-disable" id="bl-start">⬇ Bắt đầu tải</button>
              <span class="muted" style="font-size:12.5px">Có thể dừng bất cứ lúc nào — lần sau tải lại sẽ tự nối tiếp.</span>
            </div>
          </section>
        </div>

        <aside>
          ${logCard("Nhật ký tải", 40, "300px")}
          <section class="card">
            <header class="card-head"><h3>🕘 Mới tải gần đây</h3><a href="#/project/${esc(state.activeProjectId)}/bilibili-library">Xem tất cả →</a></header>
            <div class="card-body p0" id="bl-recent"></div>
          </section>
        </aside>
      </div>`,

    mount() {
      $$(".chip[data-url]").forEach((c) => (c.onclick = () => {
        $("#bl-url").value = c.dataset.url;
        $("#bl-url").focus();
      }));
      $$(".chip[data-sec]").forEach((c) => (c.onclick = () => {
        const [f, t] = c.dataset.sec.split(",");
        $("#bl-from").value = f || "";
        $("#bl-to").value = t || "";
      }));
      $("#bl-delogo").onchange = () => {
        $$("#bl-delogo .opt").forEach((o) => o.classList.toggle("checked", $("input", o).checked));
      };
      $("#bl-start").onclick = () => {
        const url = $("#bl-url").value.trim();
        if (!url) {
          toast("Vui lòng dán link Bilibili hoặc YouTube", "error");
          $("#bl-url").focus();
          return;
        }
        const from = $("#bl-from").value.trim();
        const to = $("#bl-to").value.trim();
        if ((from && !to) || (!from && to)) {
          toast("Vui lòng nhập đủ cả giờ bắt đầu và giờ kết thúc (vd: 00:00:00 → 01:00:00)", "error");
          return;
        }
        const section = from && to ? `${from}-${to}` : "";
        startTask(
          "/api/bilibili/download",
          {
            url,
            section,
            playlist_items: $("#bl-pitems").value.trim(),
            quality: $("#bl-quality").value,
            playlist: $("#bl-playlist").checked,
            delogo: ($("#bl-delogo input:checked") || {}).value || "top-right",
            perf: $("#bl-perf").value,
          },
          section ? `Bắt đầu tải đoạn ${section}...` : "Bắt đầu tải video Bilibili..."
        );
      };
      $("#bl-recent").onclick = (e) => {
        const b = e.target.closest("[data-play]");
        if (b) openPlayer(biliFileUrl(b.dataset.play), b.dataset.title);
      };
    },

    update: drawRecent,
  };
}

/* =========================================================
   TRANG 6: THƯ VIỆN BILIBILI
   ========================================================= */
function openBiliDelogoModal(localFile, title) {
  const html = `
    <div class="field">
      <label for="md-delogo">Vị trí logo cần xóa</label>
      <select id="md-delogo" class="select">
        <option value="top-right">Góc trên bên phải (video ngang)</option>
        <option value="top-left">Góc trên bên trái (video dọc)</option>
        <option value="both-top">Cả 2 góc trên</option>
      </select>
    </div>
    <div class="field">
      <label for="md-perf">Chế độ hiệu năng</label>
      <select id="md-perf" class="select">
        <option value="balanced">⚖️ Cân bằng (50% CPU, mát máy)</option>
        <option value="eco">🌿 Tiết kiệm (30% CPU, chạy nền êm)</option>
        <option value="fast">🚀 Tốc độ tối đa</option>
      </select>
      <div class="help">Xóa logo độc lập trực tiếp trên file đã tải (không cần tải lại từ mạng).</div>
    </div>
    <div class="actions" style="margin-top:16px">
      <button class="btn btn-pink js-busy-disable" id="md-run">✨ Bắt đầu xóa logo</button>
      <button class="btn btn-light" data-close>Hủy</button>
    </div>`;
  const { el, close } = openModal(`Xóa logo: ${title}`, html);
  renderTaskWidgets();
  $("#md-run", el).onclick = async () => {
    const ok = await startTask(
      "/api/bilibili/delogo",
      { local_file: localFile, delogo: $("#md-delogo", el).value, perf: $("#md-perf", el).value },
      "Đang xóa logo video..."
    );
    if (ok) close();
  };
}

function PageBiliLibrary() {
  function draw() {
    const q = state.bf.q.trim().toLowerCase();
    const items = state.bili.filter((v) => !q || (v.title || "").toLowerCase().includes(q) || (v.id || "").toLowerCase().includes(q));
    const totalMb = state.bili.reduce((a, v) => a + Number(v.size_mb || 0), 0);
    const totalSec = state.bili.reduce((a, v) => a + Number(v.duration_sec || 0), 0);

    $("#bf-stats").innerHTML = [
      statCard("🎬", "Số video", state.bili.length, "Đã tải từ Bilibili / YouTube", "pink"),
      statCard("💾", "Dung lượng", fmtSize(totalMb), "Trong downloads/bilibili/", "green"),
      statCard("⏱️", "Tổng thời lượng", fmtDur(totalSec) || "0:00", "Cộng dồn tất cả video", "purple"),
    ].join("");

    $("#bf-list").innerHTML = !state.bili.length
      ? emptyState("🎬", "Thư viện đang trống", "Hãy tải video đầu tiên từ Bilibili hoặc YouTube.", `<a class="btn btn-pink" href="#/bilibili/new">➕ Tải video mới</a>`)
      : !items.length
        ? emptyState("🔎", "Không tìm thấy video", "Thử từ khóa khác.")
        : `<div class="vgrid">${items.map((v) => `
            <article class="vcard" style="cursor:default">
              <div class="vthumb">
                <video src="${esc(biliFileUrl(v.local_file))}#t=2" preload="metadata" muted playsinline></video>
                <div class="tl"><span class="ov">${esc(v.resolution || "MP4")}</span></div>
                <div class="tr">${v.delogo && v.delogo !== "none" ? `<span class="ov pink">✨ Đã xóa logo</span>` : ""}</div>
                <div class="bl"><span class="ov green">${fmtSize(v.size_mb)}</span></div>
                <div class="br">${v.duration_sec ? `<span class="ov">${fmtDur(v.duration_sec)}</span>` : ""}</div>
              </div>
              <div class="vbody">
                <div class="vtitle" title="${esc(v.title)}">${esc(v.title)}</div>
                <div class="vmeta"><span>🆔 ${esc(v.id)}</span><span>${esc(DELOGO_LABEL[v.delogo] || "")}</span></div>
                <div class="vmeta"><span>👤 ${esc(v.uploader || "—")}</span><span>${dateOnly(v.downloaded_at)}</span></div>
                <div class="vactions">
                  <button class="btn btn-success btn-sm" data-act="play" data-file="${esc(v.local_file)}" data-title="${esc(v.title)}">▶ Xem</button>
                  <button class="btn btn-light btn-sm js-busy-disable" data-act="delogo" data-file="${esc(v.local_file)}" data-title="${esc(v.title)}">✨ Logo</button>
                  <a class="btn btn-light btn-sm" href="${esc(biliFileUrl(v.local_file))}" download>💾 Lưu</a>
                  <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red)" data-act="delete" data-file="${esc(v.local_file)}" data-title="${esc(v.title)}">🗑</button>
                </div>
              </div>
            </article>`).join("")}</div>`;
  }

  return {
    render: () => `
      <div class="stats" id="bf-stats"></div>
      <section class="card">
        <div class="card-body">
          <div class="toolbar">
            <input id="bf-q" class="input" type="search" placeholder="🔍  Tìm theo tiêu đề hoặc mã video (BV...)" />
            <a class="btn btn-pink" href="#/project/${esc(state.activeProjectId)}/bilibili-new">➕ Tải video mới</a>
          </div>
        </div>
      </section>
      <div id="bf-list"></div>`,

    mount() {
      $("#bf-q").value = state.bf.q;
      $("#bf-q").oninput = (e) => {
        state.bf.q = e.target.value;
        draw();
      };
      $("#bf-list").onclick = async (e) => {
        const b = e.target.closest("[data-act]");
        if (!b) return;
        if (b.dataset.act === "play") openPlayer(biliFileUrl(b.dataset.file), b.dataset.title);
        if (b.dataset.act === "delogo") openBiliDelogoModal(b.dataset.file, b.dataset.title);
        if (b.dataset.act === "delete") {
          if (!confirm(`Xóa vĩnh viễn video này khỏi máy?\n\n${b.dataset.title}`)) return;
          const d = await postJSON("/api/bilibili/delete", { local_file: b.dataset.file });
          if (d.ok) {
            toast("Đã xóa video", "success");
            loadAll();
          } else toast(d.error || "Không xóa được", "error");
        }
      };
    },

    update: draw,
  };
}

/* =========================================================
   TRANG 6A: DỰ ÁN TRUYỆN / PHIM (NGỮ CẢNH AI — 1 DỰ ÁN NHIỀU VIDEO)
   ========================================================= */
function openNewProjectModal() {
  const html = `
    <div class="field">
      <label for="np-name">Tên dự án (tên bộ truyện / phim)</label>
      <input id="np-name" class="input" type="text" placeholder="Ví dụ: Đấu Phá Thương Khung, Phim Kiếm Hiệp..." />
    </div>
    <div class="cols cols-2" style="gap:12px">
      <div class="field" style="margin:0">
        <label for="np-type">Thể loại</label>
        <select id="np-type" class="select">
          <option value="Truyện / Hoạt hình">Truyện / Hoạt hình</option>
          <option value="Phim bộ">Phim bộ</option>
          <option value="Phim lẻ">Phim lẻ</option>
          <option value="Review / Tài liệu">Review / Tài liệu</option>
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="np-style">Phong cách dịch</label>
        <input id="np-style" class="input" type="text" value="Tự nhiên, gần gũi, giữ đúng xưng hô" />
      </div>
    </div>
    <div class="field" style="margin-top:12px">
      <label for="np-syn">Tóm tắt bối cảnh / cốt truyện (để AI hiểu ngữ cảnh)</label>
      <textarea id="np-syn" class="input" rows="4" placeholder="Mô tả ngắn nhân vật chính, bối cảnh truyện/phim, mối quan hệ nhân vật..."></textarea>
    </div>
    <div class="actions" style="margin-top:14px">
      <button class="btn btn-primary" id="np-create">➕ Tạo dự án</button>
      <button class="btn btn-light" data-close>Hủy</button>
    </div>`;
  const { el, close } = openModal("Tạo dự án Truyện / Phim mới", html);
  $("#np-name", el).focus();
  $("#np-create", el).onclick = async () => {
    const name = $("#np-name", el).value.trim();
    if (!name) return toast("Vui lòng nhập tên dự án!", "error");
    const d = await postJSON("/api/projects", {
      name,
      type: $("#np-type", el).value,
      style: $("#np-style", el).value.trim(),
      synopsis: $("#np-syn", el).value.trim(),
    });
    if (!d.ok) return toast(d.error || "Không tạo được dự án", "error");
    state.activeProjectId = d.project.id;
    toast(`Đã tạo dự án "${name}"`, "success");
    close();
    await loadAll();
    location.hash = `#/project/${d.project.id}/dubbing`;
  };
}

/* =========================================================
   NGĂN TRƯỢT BÊN PHẢI: THÔNG TIN & CÀI ĐẶT DỰ ÁN
   ========================================================= */
function openProjectDrawer(projectId, initialTab = "info") {
  const proj = state.projects.find((p) => p.id === projectId) || getActiveProject();
  if (!proj) return toast("Chưa chọn dự án nào", "error");

  // Working copy for live editing across tabs
  const draft = {
    id: proj.id,
    name: proj.name || "",
    type: proj.type || "Truyện / Hoạt hình",
    style: proj.style || "",
    synopsis: proj.synopsis || "",
    characters: (proj.characters || []).map((c) => ({ ...c })),
    glossary: (proj.glossary || []).map((g) => ({ ...g })),
    episode_notes: { ...(proj.episode_notes || {}) },
    videos: proj.videos || [],
  };
  let activeTab = initialTab;
  const root = $("#drawer-root");

  function syncTabInputs() {
    if (activeTab === "info") {
      if ($("#dr-name", root)) draft.name = $("#dr-name", root).value.trim();
      if ($("#dr-type", root)) draft.type = $("#dr-type", root).value;
      if ($("#dr-style", root)) draft.style = $("#dr-style", root).value.trim();
      if ($("#dr-syn", root)) draft.synopsis = $("#dr-syn", root).value.trim();
    } else if (activeTab === "chars") {
      draft.characters = $$("#dr-chars tr[data-ci]", root).map((tr) => ({
        zh: $(".ch-zh", tr).value.trim(),
        vi: $(".ch-vi", tr).value.trim(),
        pronouns: $(".ch-pr", tr).value.trim(),
        role: (draft.characters[Number(tr.dataset.ci)] || {}).role || "",
      }));
    } else if (activeTab === "gloss") {
      draft.glossary = $$("#dr-gloss tr[data-gi]", root).map((tr) => ({
        zh: $(".gl-zh", tr).value.trim(),
        vi: $(".gl-vi", tr).value.trim(),
      }));
    } else if (activeTab === "notes") {
      $$(".dr-ep-note", root).forEach((inp) => {
        draft.episode_notes[inp.dataset.job] = inp.value.trim();
      });
    }
  }

  function renderDrawerBody() {
    const body = $("#dr-body", root);
    if (!body) return;
    $$(".drawer-tabs button", root).forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));

    if (activeTab === "info") {
      body.innerHTML = `
        <div class="field">
          <label>Tên dự án</label>
          <input id="dr-name" class="input" value="${esc(draft.name)}" />
        </div>
        <div class="field">
          <label>Thể loại</label>
          <select id="dr-type" class="select">
            ${["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"]
              .map((t) => `<option value="${t}" ${draft.type === t ? "selected" : ""}>${t}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field">
          <label>Phong cách dịch & giọng văn</label>
          <input id="dr-style" class="input" value="${esc(draft.style)}" />
        </div>
        <div class="field">
          <label>Tóm tắt cốt truyện chung (Antigravity tự đọc khi dịch)</label>
          <textarea id="dr-syn" class="input" rows="5">${esc(draft.synopsis)}</textarea>
        </div>
        <div class="callout info">
          <span class="ci">🤖</span>
          <span>Mỗi khi bạn dịch tập mới trong dự án này, <b>Antigravity</b> sẽ tự đọc phần này, tự bổ sung nhân vật & thuật ngữ mới và lưu lại mạch truyện!</span>
        </div>`;
    } else if (activeTab === "chars") {
      body.innerHTML = `
        <div class="actions" style="justify-content:space-between;margin-bottom:12px">
          <span class="muted" style="font-size:12.5px">AI tự thêm khi gặp nhân vật mới, bạn có thể sửa lại cách xưng hô:</span>
          <button class="btn btn-light btn-sm" id="dr-add-ch">+ Thêm</button>
        </div>
        <div class="table-wrap" style="border:1px solid var(--border);border-radius:10px">
          <table class="tbl">
            <thead><tr><th>Gốc</th><th>Tên Việt</th><th>Xưng hô</th><th></th></tr></thead>
            <tbody id="dr-chars">
              ${draft.characters.map((c, i) => `
                <tr data-ci="${i}">
                  <td><input class="input ch-zh" value="${esc(c.zh)}" style="padding:5px 7px;font-size:12.5px" /></td>
                  <td><input class="input ch-vi" value="${esc(c.vi)}" style="padding:5px 7px;font-size:12.5px" /></td>
                  <td><input class="input ch-pr" value="${esc(c.pronouns || "")}" style="padding:5px 7px;font-size:12.5px" /></td>
                  <td><button class="btn btn-ghost btn-sm" style="color:var(--red)" data-rm-ch="${i}">✕</button></td>
                </tr>`).join("") || `<tr><td colspan="4" class="muted">Chưa có nhân vật.</td></tr>`}
            </tbody>
          </table>
        </div>`;
      $("#dr-add-ch", body).onclick = () => {
        syncTabInputs();
        draft.characters.push({ zh: "", vi: "", pronouns: "", role: "" });
        renderDrawerBody();
      };
      $$("[data-rm-ch]", body).forEach((b) => (b.onclick = () => {
        syncTabInputs();
        draft.characters.splice(Number(b.dataset.rmCh), 1);
        renderDrawerBody();
      }));
    } else if (activeTab === "gloss") {
      body.innerHTML = `
        <div class="actions" style="justify-content:space-between;margin-bottom:12px">
          <span class="muted" style="font-size:12.5px">Thuật ngữ, chiêu thức, từ lóng riêng của bộ này:</span>
          <button class="btn btn-light btn-sm" id="dr-add-gl">+ Thêm</button>
        </div>
        <div class="table-wrap" style="border:1px solid var(--border);border-radius:10px">
          <table class="tbl">
            <thead><tr><th>Từ gốc</th><th>Dịch tiếng Việt</th><th></th></tr></thead>
            <tbody id="dr-gloss">
              ${draft.glossary.map((g, i) => `
                <tr data-gi="${i}">
                  <td><input class="input gl-zh" value="${esc(g.zh)}" style="padding:5px 7px;font-size:12.5px" /></td>
                  <td><input class="input gl-vi" value="${esc(g.vi)}" style="padding:5px 7px;font-size:12.5px" /></td>
                  <td><button class="btn btn-ghost btn-sm" style="color:var(--red)" data-rm-gl="${i}">✕</button></td>
                </tr>`).join("") || `<tr><td colspan="3" class="muted">Chưa có thuật ngữ.</td></tr>`}
            </tbody>
          </table>
        </div>`;
      $("#dr-add-gl", body).onclick = () => {
        syncTabInputs();
        draft.glossary.push({ zh: "", vi: "" });
        renderDrawerBody();
      };
      $$("[data-rm-gl]", body).forEach((b) => (b.onclick = () => {
        syncTabInputs();
        draft.glossary.splice(Number(b.dataset.rmGl), 1);
        renderDrawerBody();
      }));
    } else if (activeTab === "notes") {
      const vids = draft.videos || [];
      body.innerHTML = vids.length
        ? vids.map((v, i) => `
            <div class="field" style="padding:12px;border:1px solid var(--border);border-radius:10px;background:#fafbfd">
              <label style="font-size:12.5px">Tập ${i + 1}: ${esc(v.title)}</label>
              <textarea class="input dr-ep-note" data-job="${esc(v.job_id)}" rows="2" style="font-size:13px">${esc(draft.episode_notes[v.job_id] || "")}</textarea>
            </div>`).join("")
        : `<div class="muted">Chưa có video nào được lồng tiếng trong dự án này.</div>`;
    }
  }

  function closeDrawer() {
    root.innerHTML = "";
    document.removeEventListener("keydown", onEsc);
  }
  const onEsc = (e) => {
    if (e.key === "Escape") closeDrawer();
  };

  root.innerHTML = `
    <div class="drawer-bg">
      <div class="drawer">
        <div class="drawer-head">
          <h3>⚙️ Cài đặt dự án</h3>
          <button class="btn btn-light btn-sm" data-close>✕ Đóng</button>
        </div>
        <div class="drawer-tabs">
          <button data-tab="info">📖 Thông tin</button>
          <button data-tab="chars">👥 Nhân vật (${draft.characters.length})</button>
          <button data-tab="gloss">📚 Từ điển (${draft.glossary.length})</button>
          <button data-tab="notes">🎬 Mạch truyện (${draft.videos.length})</button>
        </div>
        <div class="drawer-body" id="dr-body"></div>
        <div class="drawer-foot">
          <div class="actions" style="gap:6px">
            <button class="btn btn-light btn-sm" id="dr-copy">📋 Copy ngữ cảnh</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" id="dr-del">🗑 Xóa</button>
          </div>
          <button class="btn btn-primary" id="dr-save">💾 Lưu cài đặt</button>
        </div>
      </div>
    </div>`;

  renderDrawerBody();
  document.addEventListener("keydown", onEsc);

  root.firstElementChild.onclick = (e) => {
    if (e.target === root.firstElementChild || e.target.closest("[data-close]")) closeDrawer();
  };
  $$(".drawer-tabs button", root).forEach((b) => (b.onclick = () => {
    syncTabInputs();
    activeTab = b.dataset.tab;
    renderDrawerBody();
  }));
  $("#dr-copy", root).onclick = () => {
    syncTabInputs();
    copyText(buildAiContextPrompt(draft));
  };
  $("#dr-save", root).onclick = async () => {
    syncTabInputs();
    const d = await postJSON("/api/projects/save", {
      id: draft.id,
      name: draft.name,
      type: draft.type,
      style: draft.style,
      synopsis: draft.synopsis,
      characters: draft.characters.filter((c) => c.zh || c.vi),
      glossary: draft.glossary.filter((g) => g.zh || g.vi),
      episode_notes: draft.episode_notes,
    });
    if (d.ok) {
      toast("Đã lưu cài đặt dự án!", "success");
      await loadAll();
      closeDrawer();
    } else toast(d.error || "Lưu thất bại", "error");
  };
  $("#dr-del", root).onclick = async () => {
    if (!confirm(`Xóa dự án "${draft.name}"? (Các file MP4 vẫn được giữ nguyên)`)) return;
    await postJSON("/api/projects/delete", { id: draft.id });
    state.activeProjectId = "";
    toast("Đã xóa dự án", "success");
    closeDrawer();
    await loadAll();
    location.hash = "#/projects";
  };
}

function buildAiContextPrompt(proj) {
  const chars = (proj.characters || [])
    .map((c) => `- ${c.zh} → ${c.vi} (${c.role || ""}; xưng hô: ${c.pronouns || ""})`)
    .join("\n");
  const gloss = (proj.glossary || []).map((g) => `- ${g.zh} → ${g.vi}`).join("\n");
  const eps = (proj.videos || [])
    .map((v, i) => `- Tập ${i + 1} (${v.title}): ${(proj.episode_notes || {})[v.job_id] || "(chưa có tóm tắt)"}`)
    .join("\n");
  return [
    `=== NGỮ CẢNH DỰ ÁN: ${proj.name} (${proj.type}) ===`,
    `Phong cách dịch: ${proj.style || ""}`,
    `Cốt truyện chung: ${proj.synopsis || ""}`,
    "",
    "Nhân vật & Xưng hô:",
    chars || "(chưa có)",
    "",
    "Từ điển thuật ngữ:",
    gloss || "(chưa có)",
    "",
    "Mạch truyện các video trước trong dự án:",
    eps || "(chưa có)",
    "",
    "Yêu cầu: Dựa vào ngữ cảnh trên, hãy sửa lỗi nghe nhầm của Whisper và dịch lời thoại tập tiếp theo thật tự nhiên, đúng xưng hô và giữ liền mạch cốt truyện.",
  ].join("\n");
}

function PageProjects() {
  function draw() {
    const totalVids = state.projects.reduce((a, p) => a + (p.video_count || 0), 0);
    const totalChars = state.projects.reduce((a, p) => a + (p.characters || []).length, 0);

    $("#pj-stats").innerHTML = [
      statCard("📁", "Dự án của bạn", state.projects.length, "Mỗi bộ truyện hoặc phim là 1 dự án riêng", "purple"),
      statCard("🎬", "Video đã lồng tiếng", totalVids, "Quản lý gọn theo từng dự án", "green"),
      statCard("🧠", "Nhân vật AI đã nhớ", totalChars, "Tự động đồng nhất xưng hô & thuật ngữ", "pink"),
    ].join("");

    const cards = state.projects.map((p) => {
      const ico = p.type?.includes("Phim") ? "🎥" : p.type?.includes("Review") ? "📝" : "🎣";
      return `
        <article class="pcard" data-open="${esc(p.id)}">
          <div class="pcard-top">
            <div class="pcard-ico">${ico}</div>
            <div style="min-width:0;flex:1">
              <div class="pcard-title">${esc(p.name)}</div>
              <div style="margin-top:4px"><span class="badge purple">${esc(p.type || "Truyện / Hoạt hình")}</span></div>
            </div>
            <button class="btn btn-light btn-sm" data-cfg="${esc(p.id)}" title="Cài đặt & Ngữ cảnh dự án">⚙️</button>
          </div>
          <div class="pcard-syn">${esc(p.synopsis || "Chưa có mô tả cốt truyện. Bấm ⚙️ để xem hoặc cập nhật.")}</div>
          <div class="pcard-foot">
            <span>🎬 <b>${p.video_count || 0}</b> video · 👥 <b>${(p.characters || []).length}</b> nhân vật · 📚 <b>${(p.glossary || []).length}</b> thuật ngữ</span>
            <span style="color:var(--primary);font-weight:600">Mở →</span>
          </div>
        </article>`;
    }).join("");

    $("#pj-grid").innerHTML = `
      <div class="proj-grid">
        ${cards}
        <div class="pcard pcard-new" onclick="openNewProjectModal()">
          <div class="plus">＋</div>
          <div style="font-weight:700;font-size:15px">Tạo dự án mới</div>
          <div style="font-size:12.5px;margin-top:4px">Thêm 1 bộ truyện, hoạt hình hoặc bộ phim mới</div>
        </div>
      </div>`;
  }

  return {
    render: () => `
      <div class="stats" id="pj-stats"></div>
      <div id="pj-grid"></div>`,

    mount() {
      $("#pj-grid").onclick = (e) => {
        const cfg = e.target.closest("[data-cfg]");
        if (cfg) {
          e.stopPropagation();
          openProjectDrawer(cfg.dataset.cfg);
          return;
        }
        const card = e.target.closest("[data-open]");
        if (card) {
          state.activeProjectId = card.dataset.open;
          location.hash = `#/project/${card.dataset.open}/dubbing`;
        }
      };
    },

    update: draw,
  };
}

/* =========================================================
   TRANG 6B: DỊCH & LỒNG TIẾNG VIỆT (0.5x + Whisper + Edge-TTS)
   ========================================================= */
async function openDubEditorModal(jobId) {
  let proj;
  try {
    proj = await getJSON("/api/dub/project?id=" + encodeURIComponent(jobId));
    if (proj.error) throw new Error(proj.error);
  } catch (e) {
    toast(e.message || "Không tải được dữ liệu phụ đề", "error");
    return;
  }

  const segs = proj.segments || [];
  const rowsHtml = segs.map((s, i) => `
    <tr data-idx="${i}">
      <td class="nowrap muted" style="font-size:12px">${s.start}s → ${s.end}s</td>
      <td style="font-size:13px;color:var(--text-2);width:36%">${esc(s.zh)}</td>
      <td><input class="input seg-vi" type="text" value="${esc(s.vi)}" style="padding:6px 10px;font-size:13.5px" /></td>
    </tr>`).join("");

  const html = `
    <div class="callout info" style="margin-top:0;margin-bottom:14px">
      <span class="ci">✏️</span>
      <span>Chỉnh sửa câu tiếng Việt bất kỳ bên dưới rồi bấm <b>Lưu & Xuất lại lồng tiếng</b> — hệ thống bỏ qua bước nhận diện, đọc lại bằng giọng AI mới chỉ trong vài giây!</span>
    </div>
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <label class="label" for="ed-voice">Giọng đọc khi xuất lại</label>
        <select id="ed-voice" class="select">
          <option value="vi-VN-NamMinhNeural" ${proj.voice === "vi-VN-NamMinhNeural" ? "selected" : ""}>👨 Nam Minh (Nam trầm kể chuyện)</option>
          <option value="vi-VN-HoaiMyNeural" ${proj.voice === "vi-VN-HoaiMyNeural" ? "selected" : ""}>👩 Hoài My (Nữ tự nhiên)</option>
        </select>
      </div>
      <div style="padding-bottom:10px">
        <label class="check"><input id="ed-sub" type="checkbox" ${proj.burn_sub !== false ? "checked" : ""} /> In cứng phụ đề lên video</label>
      </div>
    </div>
    <div class="table-wrap" style="max-height:46vh;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
      <table class="tbl">
        <thead><tr><th>Mốc giờ</th><th>Tiếng Trung gốc</th><th>Lời dịch & lồng tiếng Việt (sửa trực tiếp)</th></tr></thead>
        <tbody id="ed-tbody">${rowsHtml || `<tr><td colspan="3" class="muted">Không có câu thoại nào.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="actions" style="margin-top:16px">
      <button class="btn btn-primary js-busy-disable" id="ed-save">🎙️ Lưu & Xuất lại lồng tiếng</button>
      <button class="btn btn-light" data-close>Đóng</button>
    </div>`;

  const { el, close } = openModal(`Sửa bản dịch (${segs.length} câu): ${proj.title}`, html, { wide: true });
  renderTaskWidgets();

  $("#ed-save", el).onclick = async () => {
    const inputs = $$(".seg-vi", el);
    const updated = segs.map((s, i) => ({ ...s, vi: inputs[i] ? inputs[i].value.trim() : s.vi }));
    const ok = await startTask(
      "/api/dub/rerender",
      {
        job_id: jobId,
        segments: updated,
        voice: $("#ed-voice", el).value,
        burn_sub: $("#ed-sub", el).checked,
      },
      "Đang đọc lại giọng tiếng Việt và ghép video..."
    );
    if (ok) close();
  };
}

function openDeleteVideoModal(relPath, title, jobId) {
  const html = `
    <div class="callout warn" style="margin-top:0;margin-bottom:14px;background:var(--red-50);border-color:#fecaca;color:#991b1b">
      <span class="ci">⚠️</span>
      <span><b>Hành động này sẽ xóa vĩnh viễn file trên ổ cứng</b> và không thể khôi phục lại!</span>
    </div>
    <div class="field">
      <label>Video sẽ bị xóa:</label>
      <div style="padding:10px 12px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;font-size:13px">
        <div style="font-weight:600">${esc(title)}</div>
        <div class="muted" style="font-size:12px;margin-top:3px"><code>${esc(relPath)}</code></div>
      </div>
    </div>
    ${jobId ? `
      <div class="field" style="margin-top:12px">
        <label class="check">
          <input id="del-dub-chk" type="checkbox" checked />
          Xóa luôn cả bản đã lồng tiếng Việt & phụ đề (<code>.mp4</code>, <code>.srt</code>)
        </label>
      </div>` : ""}
    <div class="actions" style="margin-top:18px;justify-content:flex-end">
      <button class="btn btn-light" data-close>Hủy</button>
      <button class="btn btn-danger" id="del-confirm">🗑 Xóa vĩnh viễn</button>
    </div>`;

  const { el, close } = openModal("Xác nhận xóa video", html);
  $("#del-confirm", el).onclick = async () => {
    const btn = $("#del-confirm", el);
    btn.disabled = true;
    btn.textContent = "Đang xóa...";
    const deleteDubbed = jobId ? ($("#del-dub-chk", el)?.checked ?? true) : false;
    const d = await postJSON("/api/source/delete", {
      rel_path: relPath,
      job_id: jobId || "",
      delete_dubbed: deleteDubbed,
    });
    if (d.ok) {
      toast("Đã xóa vĩnh viễn video khỏi ổ cứng", "success");
      close();
      loadAll();
    } else {
      toast(d.error || "Không xóa được video", "error");
      btn.disabled = false;
      btn.textContent = "🗑 Xóa vĩnh viễn";
    }
  };
}

function openDubConfigModal(relPath, title) {
  const proj = getActiveProject();
  const html = `
    <div class="callout info" style="margin-top:0;margin-bottom:14px">
      <span class="ci">🤖</span>
      <span>Dự án: <b>${esc(proj?.name || "Mặc định")}</b> — Antigravity sẽ tự đọc ngữ cảnh, sửa lỗi nghe nhầm, dịch chuẩn mạch truyện và tự lưu nhân vật mới!</span>
    </div>
    <div class="cols cols-2" style="gap:12px">
      <div class="field" style="margin:0">
        <label for="mc-speed">Làm chậm tạm khi tách âm</label>
        <select id="mc-speed" class="select">
          <option value="0.5" selected>🐢 0.5x tách âm → Xuất 1.0x gốc</option>
          <option value="0.65">0.65x tách âm → Xuất 1.0x gốc</option>
          <option value="0.8">0.8x tách âm → Xuất 1.0x gốc</option>
          <option value="1.0">1.0x (không làm chậm)</option>
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="mc-voice">Giọng lồng tiếng Việt</label>
        <select id="mc-voice" class="select">
          <option value="vi-VN-NamMinhNeural">👨 Nam Minh (Nam trầm kể chuyện)</option>
          <option value="vi-VN-HoaiMyNeural">👩 Hoài My (Nữ tự nhiên)</option>
        </select>
      </div>
    </div>
    <div class="cols cols-2" style="gap:12px;margin-top:12px">
      <div class="field" style="margin:0">
        <label for="mc-model">Mô hình nhận diện (Whisper)</label>
        <select id="mc-model" class="select">
          <option value="base">Base — Nhanh, nhẹ</option>
          <option value="small">Small — Chính xác hơn</option>
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="mc-bg">Âm thanh gốc làm nền</label>
        <select id="mc-bg" class="select">
          <option value="0.05" selected>5% — Rất nhỏ</option>
          <option value="0">0% — Tắt hẳn âm gốc</option>
          <option value="0.12">12% — Rõ tiếng động nền</option>
        </select>
      </div>
    </div>
    <div style="margin-top:12px">
      <label class="check"><input id="mc-sub" type="checkbox" checked /> In cứng phụ đề tiếng Việt nền đen (che chữ Trung cũ)</label>
    </div>
    <div class="actions" style="margin-top:16px">
      <button class="btn btn-primary btn-lg js-busy-disable" id="mc-run">🚀 Bắt đầu Dịch & Lồng tiếng</button>
      <button class="btn btn-light" data-close>Hủy</button>
    </div>`;

  const { el, close } = openModal(`Cấu hình Dịch & Lồng tiếng: ${title}`, html);
  renderTaskWidgets();
  $("#mc-run", el).onclick = async () => {
    const ok = await startTask(
      "/api/dub/start",
      {
        project_id: state.activeProjectId || "",
        rel_path: relPath,
        speed: Number($("#mc-speed", el).value),
        voice: $("#mc-voice", el).value,
        model: $("#mc-model", el).value,
        bg_volume: Number($("#mc-bg", el).value),
        burn_sub: $("#mc-sub", el).checked,
      },
      "Đang chạy Dịch & Lồng tiếng! Xem thanh tiến trình ngay dưới video."
    );
    if (ok) close();
  };
}

function PageDubbing() {
  function draw() {
    const proj = getActiveProject();
    const diskEl = $("#ws-disk");
    if (diskEl && state.sys.free_gb) {
      diskEl.innerHTML = `💾 Ổ cứng trống: <b>${state.sys.free_gb} GB</b>`;
    }

    // Build unified video list: Bilibili + Douyin local sources matched with their dubbed versions
    const dubByTitle = new Map(state.dubbed.map((d) => [d.title, d]));
    const biliByFile = new Map(state.bili.map((b) => [b.local_file, b]));

    const items = state.sources.map((s) => {
      const fname = s.rel_path.split("/").pop();
      const bMeta = biliByFile.get(fname) || {};
      const dub = dubByTitle.get(fname) || null;
      return {
        rel_path: s.rel_path,
        fname,
        source: s.source,
        title: bMeta.title || fname,
        resolution: bMeta.resolution || dub?.resolution || "MP4",
        duration_sec: bMeta.duration_sec || dub?.duration_sec || 0,
        size_mb: bMeta.size_mb || 0,
        delogo: bMeta.delogo || "none",
        video_src: s.source === "bilibili" ? biliFileUrl(fname) : douyinFileUrl(fname),
        dub,
      };
    });

    $("#dub-stats").innerHTML = [
      statCard("🎬", "Video trong máy", items.length, "Sẵn sàng để dịch & lồng tiếng", "green"),
      statCard("🎙️", "Đã lồng tiếng Việt", state.dubbed.length, "100% dịch tự động bằng Antigravity", "purple"),
      statCard("🧠", "Ngữ cảnh dự án", `${(proj?.characters || []).length} nhân vật`, `${(proj?.glossary || []).length} thuật ngữ đã nhớ`, "pink"),
    ].join("");

    $("#ws-video-list").innerHTML = !items.length
      ? emptyState("🎬", "Chưa có video nào", "Dán link Bilibili ở khung phía trên để tải video đầu tiên vào dự án!")
      : `<div class="vgrid">${items.map((v) => {
          const d = v.dub;
          return `
            <article class="vcard" style="cursor:default">
              <div class="vthumb">
                <video src="${esc(v.video_src)}#t=2" preload="metadata" muted playsinline></video>
                <div class="tl"><span class="ov">${esc(v.resolution)}</span></div>
                <div class="tr">
                  ${d ? `<span class="ov purple">🎙️ Đã lồng tiếng</span>` : v.delogo !== "none" ? `<span class="ov pink">✨ Sạch logo</span>` : ""}
                </div>
                <div class="bl"><span class="ov green">${v.size_mb ? fmtSize(v.size_mb) : v.source.toUpperCase()}</span></div>
                <div class="br">${v.duration_sec ? `<span class="ov">${fmtDur(v.duration_sec)}</span>` : ""}</div>
              </div>
              <div class="vbody">
                <div class="vtitle" title="${esc(v.title)}">${esc(v.title)}</div>

                <!-- Thanh tiến trình & trạng thái hiển thị NGAY DƯỚI VIDEO khi đang chạy -->
                <div class="js-vid-prog" data-target="${esc(v.rel_path)}" data-job="${esc(d?.job_id || "")}" style="display:none;padding:8px 10px;background:var(--primary-50);border:1px solid #c7d7fe;border-radius:8px"></div>

                <div class="vactions">
                  <button class="btn btn-primary btn-sm js-busy-disable" data-act="dub" data-rel="${esc(v.rel_path)}" data-title="${esc(v.title)}">🎙️ Dịch & Lồng tiếng</button>
                  <button class="btn btn-light btn-sm" data-act="play-orig" data-src="${esc(v.video_src)}" data-title="${esc(v.title)}">▶ Gốc</button>
                  ${v.source === "bilibili" ? `<button class="btn btn-ghost btn-sm js-busy-disable" data-act="delogo" data-file="${esc(v.fname)}" data-title="${esc(v.title)}" title="Xóa logo">✨</button>` : ""}
                  <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red)" data-act="delete-src" data-rel="${esc(v.rel_path)}" data-title="${esc(v.title)}" data-job="${esc(d?.job_id || "")}" title="Xóa vĩnh viễn video">🗑</button>
                </div>

                ${d ? `
                  <div style="margin-top:6px;padding-top:8px;border-top:1px dashed var(--border);display:flex;gap:5px;flex-wrap:wrap;align-items:center">
                    <button class="btn btn-success btn-sm" data-act="play-dub" data-file="${esc(d.mp4_file)}" data-title="Bản Việt: ${esc(v.title)}">▶ Xem bản Việt</button>
                    <button class="btn btn-light btn-sm" data-act="edit-dub" data-job="${esc(d.job_id)}">✏️ Sửa lời (${d.segment_count || 0})</button>
                    <a class="btn btn-ghost btn-sm" href="${esc(dubFileUrl(d.mp4_file))}" download>💾 MP4</a>
                    <a class="btn btn-ghost btn-sm" href="${esc(dubFileUrl(d.srt_file))}" download>SRT</a>
                  </div>` : ""}
              </div>
            </article>`;
        }).join("")}</div>`;

    renderTaskWidgets();
  }

  return {
    render: () => `
      <div class="stats" id="dub-stats"></div>

      <!-- Khung tải nhanh video Bilibili / YouTube ngay trong Project -->
      <section class="card">
        <header class="card-head">
          <h3>➕ Tải video Bilibili / YouTube vào dự án</h3>
          <span class="hint" id="ws-disk"></span>
        </header>
        <div class="card-body">
          <div class="row" style="gap:10px;align-items:center">
            <input id="ws-url" class="input grow" type="text" placeholder="Dán link Bilibili (https://www.bilibili.com/video/BV...) hoặc YouTube..." />
            <input id="ws-from" class="input" style="width:105px" type="text" placeholder="00:00:00" title="Từ giờ (để trống = tải hết)" />
            <span class="muted">→</span>
            <input id="ws-to" class="input" style="width:105px" type="text" placeholder="00:02:00" title="Đến giờ (để trống = tải hết)" />
            <select id="ws-delogo" class="select" style="width:auto">
              <option value="top-right">Xóa logo phải</option>
              <option value="top-left">Xóa logo trái</option>
              <option value="both-top">Xóa 2 góc trên</option>
              <option value="none">Không xóa logo</option>
            </select>
            <button class="btn btn-pink js-busy-disable" id="ws-dl-btn">⬇ Tải video</button>
          </div>
          <div class="chips" style="margin-top:8px">
            <button class="chip" type="button" data-preset="https://www.bilibili.com/video/BV1teKEzeEfZ/|00:01:05|00:02:05">⚡ Thử cắt 1 phút tiếp theo (Tập 151–200)</button>
            <button class="chip" type="button" data-preset="https://www.bilibili.com/video/BV1nHW3z3EhH/||">⚡ Tập lẻ 楚新钓 (84s)</button>
          </div>
          <div id="ws-dl-prog" style="display:none;margin-top:12px"></div>
        </div>
      </section>

      <!-- Danh sách video trong dự án -->
      <section style="margin-top:6px">
        <div class="list-meta" style="margin-bottom:12px">
          <h3 style="margin:0;font-size:16px">🎬 Danh sách video (bấm "🎙️ Dịch & Lồng tiếng" để chọn cấu hình và chạy)</h3>
          <a href="#/project/${esc(state.activeProjectId)}/logs" style="font-size:13px">Xem nhật ký chi tiết →</a>
        </div>
        <div id="ws-video-list"></div>
      </section>`,

    mount() {
      $$("[data-preset]").forEach((b) => (b.onclick = () => {
        const [u, f, t] = b.dataset.preset.split("|");
        $("#ws-url").value = u || "";
        $("#ws-from").value = f || "";
        $("#ws-to").value = t || "";
      }));

      $("#ws-dl-btn").onclick = () => {
        const url = $("#ws-url").value.trim();
        if (!url) return toast("Vui lòng dán link Bilibili hoặc YouTube!", "error");
        const f = $("#ws-from").value.trim();
        const t = $("#ws-to").value.trim();
        const section = f && t ? `${f}-${t}` : "";
        startTask(
          "/api/bilibili/download",
          { url, section, quality: "720p", delogo: $("#ws-delogo").value, perf: "balanced" },
          "Đang tải video vào dự án..."
        );
      };

      $("#ws-video-list").onclick = (e) => {
        const b = e.target.closest("[data-act]");
        if (!b) return;
        const act = b.dataset.act;
        if (act === "dub") openDubConfigModal(b.dataset.rel, b.dataset.title);
        if (act === "play-orig") openPlayer(b.dataset.src, b.dataset.title);
        if (act === "play-dub") openPlayer(dubFileUrl(b.dataset.file), b.dataset.title);
        if (act === "edit-dub") openDubEditorModal(b.dataset.job);
        if (act === "delogo") openBiliDelogoModal(b.dataset.file, b.dataset.title);
        if (act === "delete-src") openDeleteVideoModal(b.dataset.rel, b.dataset.title, b.dataset.job);
      };
    },

    update: draw,
  };
}

/* =========================================================
   TRANG 7: NHẬT KÝ
   ========================================================= */
function PageLogs() {
  return {
    render: () => `
      <section class="card">
        <header class="card-head">
          <h3>📜 Nhật ký chi tiết</h3>
          <div class="actions">
            <button class="btn btn-light btn-sm" id="log-copy">📋 Sao chép</button>
            <button class="btn btn-danger btn-sm js-stop" onclick="stopTask()" disabled>⏹ Dừng tiến trình</button>
          </div>
        </header>
        <div class="card-body">
          <div class="task-status js-task-status idle"><span class="dot"></span> Đang kiểm tra...</div>
          <pre class="console tall js-log" data-limit="0"></pre>
          <div class="help">Hiển thị tối đa 200 dòng gần nhất của tiến trình đang chạy hoặc vừa kết thúc. Tự động cập nhật mỗi 2,5 giây.</div>
        </div>
      </section>`,
    mount() {
      $("#log-copy").onclick = () => copyText((state.task.logs || []).join("\n"));
    },
  };
}

/* =========================================================
   TRANG 8: HƯỚNG DẪN
   ========================================================= */
function PageHelp() {
  return {
    render: () => `
      <div class="cols cols-2">
        <section class="card">
          <header class="card-head"><h3>🚀 Cách dùng nhanh</h3></header>
          <div class="card-body prose">
            <ol>
              <li><b>Quét kênh</b>: vào <a href="#/douyin/scan">Quét kênh</a> → bấm <b>Quét nối tiếp</b>. Lần đầu cần <b>Đăng nhập Chrome</b>.</li>
              <li><b>Chọn video</b>: vào <a href="#/douyin/videos">Danh sách video</a>, lọc <b>Phần 2</b> và sắp xếp <b>Cũ nhất trước</b> để xem đúng mạch truyện.</li>
              <li><b>Tải video</b>: vào <a href="#/douyin/downloads">Tải video</a> → chọn phần + khoảng tập → <b>Bắt đầu tải</b>.</li>
              <li><b>Tập bị thiếu (138–314)</b>: vào <a href="#/bilibili/new">Tải video mới</a>, dán link Bilibili, chọn vị trí logo → <b>Tải & xóa logo</b>.</li>
              <li><b>Đánh dấu đã reup</b>: bấm vào một video → đổi <b>Trạng thái reup</b>.</li>
            </ol>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>📚 Cấu trúc nội dung kênh 楚新钓</h3></header>
          <div class="card-body p0">
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>Phần</th><th>Thời gian đăng</th><th>Số tập</th></tr></thead>
              <tbody>
                <tr><td>${seasonBadge({ _season: "p1" })}</td><td>11/2023 → 07/2024</td><td>Tập 1 → 137</td></tr>
                <tr><td><span class="badge red" style="background:var(--red-50);color:var(--red)">Thiếu</span></td><td>Nghỉ ~1 năm</td><td>Tập 138 → 314 (tìm trên Bilibili)</td></tr>
                <tr><td>${seasonBadge({ _season: "p1" })}</td><td>06/2025 → 02/2026</td><td>Tập 315 → 467</td></tr>
                <tr><td>${seasonBadge({ _season: "p2" })}</td><td>02/2026 → nay</td><td>Tập 1 → 275 (liền mạch)</td></tr>
              </tbody>
            </table></div>
          </div>
        </section>
      </div>

      <section class="card">
        <header class="card-head"><h3>📁 Vị trí các file</h3></header>
        <div class="card-body p0">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Đường dẫn</th><th>Nội dung</th></tr></thead>
            <tbody>
              <tr><td><code>data/videos.json</code>, <code>data/videos.csv</code></td><td>Danh sách video Douyin đã quét</td></tr>
              <tr><td><code>downloads/</code></td><td>Video MP4 tải từ Douyin</td></tr>
              <tr><td><code>data/bilibili.json</code></td><td>Danh sách video Bilibili / YouTube đã tải</td></tr>
              <tr><td><code>downloads/bilibili/</code></td><td>Video MP4 tải từ Bilibili / YouTube (đã xóa logo)</td></tr>
              <tr><td><code>chrome_profile/</code></td><td>Phiên đăng nhập Douyin của Chrome</td></tr>
            </tbody>
          </table></div>
        </div>
      </section>

      <div class="cols cols-2">
        <section class="card">
          <header class="card-head"><h3>⌨️ Lệnh dòng lệnh (tùy chọn)</h3></header>
          <div class="card-body prose">
            <p>Khởi động giao diện web:</p>
            <pre class="code">node server.mjs   # mở http://localhost:3456</pre>
            <p>Quét kênh Douyin nối tiếp:</p>
            <pre class="code">node list_channel_web.mjs --resume</pre>
            <p>Tải video Bilibili và xóa logo góc phải:</p>
            <pre class="code">node download_bilibili.mjs --url "https://www.bilibili.com/video/BV..." --delogo top-right</pre>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>❓ Câu hỏi thường gặp</h3></header>
          <div class="card-body">
            <details class="faq"><summary>Quét kênh bị dừng sớm, không đủ video?</summary>
              <p>Do mạng chậm hoặc Douyin yêu cầu xác minh. Mở cửa sổ Chrome đang chạy để kiểm tra, sau đó bấm <b>Quét nối tiếp</b> lần nữa — dữ liệu cũ vẫn được giữ.</p></details>
            <details class="faq"><summary>Tải video Douyin bị lỗi 403?</summary>
              <p>Link tải đã hết hạn. Bấm <b>Quét nối tiếp</b> để làm mới link rồi tải lại.</p></details>
            <details class="faq"><summary>Video Bilibili vẫn còn logo?</summary>
              <p>Logo có thể nằm ở góc khác. Tải lại và chọn <b>Cả 2 góc trên</b>, hoặc chọn đúng góc chứa logo.</p></details>
            <details class="faq"><summary>Báo "Đang có tiến trình khác chạy"?</summary>
              <p>Mỗi lúc chỉ chạy 1 tiến trình. Đợi tiến trình hiện tại xong hoặc bấm <b>Dừng tiến trình</b> ở góc dưới bên trái.</p></details>
          </div>
        </section>
      </div>`,
  };
}

/* =========================================================
   ROUTER (Trang chủ = Danh sách Dự án → Bên trong Dự án)
   ========================================================= */
const GLOBAL_ROUTES = {
  "/projects": { title: "Dự án của tôi", sub: "Chọn một dự án truyện / phim để tải video, dịch và lồng tiếng", page: PageProjects },
  "/logs": { title: "Nhật ký tiến trình", sub: "Theo dõi chi tiết tiến trình đang chạy", page: PageLogs },
  "/help": { title: "Hướng dẫn sử dụng", sub: "Các bước làm, vị trí file và câu hỏi thường gặp", page: PageHelp },
};

const PROJECT_SUB_ROUTES = {
  dubbing: { title: "Dịch & Lồng tiếng AI", sub: "Làm chậm 0.5x tách âm → Antigravity dịch theo ngữ cảnh dự án → Xuất 1.0x gốc", page: PageDubbing },
  "bilibili-new": { title: "Tải video Bilibili / YouTube", sub: "Dán link → cắt khung giờ / chọn Part → tải và xóa logo", page: PageBiliNew },
  "bilibili-library": { title: "Thư viện Bilibili / YouTube", sub: "Các video đã tải về máy", page: PageBiliLibrary },
  "douyin-scan": { title: "Quét kênh Douyin", sub: "Lấy danh sách video, ảnh bìa và link tải từ Douyin Web", page: PageScan },
  "douyin-videos": { title: "Danh sách video Douyin", sub: "Xem, lọc và đánh dấu trạng thái từng tập", page: PageVideos },
  "douyin-downloads": { title: "Tải video Douyin", sub: "Tải file MP4 gốc theo phần và khoảng tập", page: PageDouyinDownloads },
  logs: { title: "Nhật ký tiến trình", sub: "Theo dõi chi tiết tiến trình đang chạy", page: PageLogs },
};

let currentPage = null;

function router() {
  const path = location.hash.replace(/^#/, "") || "/projects";
  const topActions = $("#topbar-actions");

  const projMatch = path.match(/^\/project\/([^/]+)(?:\/(.*))?$/);
  if (projMatch) {
    const pid = projMatch[1];
    const sub = projMatch[2] || "dubbing";
    const subRoute = PROJECT_SUB_ROUTES[sub];
    if (!subRoute) {
      location.hash = `#/project/${pid}/dubbing`;
      return;
    }
    state.activeProjectId = pid;
    const proj = state.projects.find((p) => p.id === pid);
    $("#page-title").textContent = subRoute.title;
    $("#page-sub").textContent = proj ? `Dự án: ${proj.name} — ${subRoute.sub}` : subRoute.sub;
    document.title = `${subRoute.title} — ${proj?.name || "Reup Studio"}`;
    topActions.innerHTML = `
      <button class="btn btn-light" onclick="openProjectDrawer('${esc(pid)}')">⚙️ Cài đặt dự án</button>
      <button class="btn btn-light" onclick="loadAll(true)">↻ Làm mới</button>`;

    renderSidebar();
    currentPage = subRoute.page();
    $("#content").innerHTML = currentPage.render();
    currentPage.mount?.();
    if (state.loaded) currentPage.update?.();
    renderTaskWidgets();
    document.body.classList.remove("sb-open");
    window.scrollTo(0, 0);
    return;
  }

  const route = GLOBAL_ROUTES[path];
  if (!route) {
    location.hash = "#/projects";
    return;
  }
  $("#page-title").textContent = route.title;
  $("#page-sub").textContent = route.sub;
  document.title = `${route.title} — Reup Studio`;
  topActions.innerHTML =
    path === "/projects"
      ? `<button class="btn btn-primary" onclick="openNewProjectModal()">➕ Tạo dự án mới</button>
         <button class="btn btn-light" onclick="loadAll(true)">↻ Làm mới</button>`
      : `<button class="btn btn-light" onclick="loadAll(true)">↻ Làm mới</button>`;

  renderSidebar();
  currentPage = route.page();
  $("#content").innerHTML = currentPage.render();
  currentPage.mount?.();
  if (state.loaded) currentPage.update?.();
  renderTaskWidgets();

  document.body.classList.remove("sb-open");
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", router);
router();
loadAll();
pollTask();
setInterval(pollTask, 2500);
