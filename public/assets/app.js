/* =========================================================
   OpenReup Studio — ứng dụng 1 trang (hash router)
   Dự án → Video & Lồng tiếng · Kho Douyin · Nhật ký
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
  task: { running: false, task_type: "", logs: [], progress: {} },
  loaded: false,
  vf: { season: "all", q: "", sort: "time_desc", status: "all", view: "grid", page: 1 },
  wf: { q: "", filter: "all" },
};

const SEASON_LABEL = { p1: "Phần 1", p2: "Phần 2", other: "Khác" };
const STATUS_LABEL = { pending: "Chưa reup", downloaded: "Đã tải", reupped: "Đã reup" };
const STATUS_TONE = { pending: "gray", downloaded: "green", reupped: "amber" };
const TASK_NAMES = {
  scan_web: "Quét kênh Douyin",
  download: "Tải video Douyin",
  bilibili_download: "Tải video Bilibili / YouTube",
  bilibili_delogo: "Xóa logo",
  dub_video: "Dịch & lồng tiếng",
  dub_rerender: "Xuất lại bản lồng tiếng",
  login_chrome: "Đăng nhập Chrome",
};
const DUB_STAGES = ["Nhận diện", "Dịch", "Giọng đọc", "Xuất video", "Ghép tiếng"];
const VOICES = [
  ["vi-VN-NamMinhNeural", "Nam Minh — nam trầm, kể chuyện"],
  ["vi-VN-HoaiMyNeural", "Hoài My — nữ, tự nhiên"],
];
const DELOGO_OPTIONS = [
  ["none", "Không xóa logo"],
  ["top-right", "Góc trên bên phải"],
  ["top-left", "Góc trên bên trái"],
  ["both-top", "Cả 2 góc trên"],
];

/* ------------------------- Icon (SVG nét mảnh, dùng chung 1 bộ) ------------------------- */
const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h.01"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.1 1-1.1 1.8M12 17h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  sparkles: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  disk: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5.5 13L8 5h8l2.5 8M7 16.5h.01M11 16.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  alert: '<path d="M12 4l9 16H3zM12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h2M11 11h6"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  brain: '<path d="M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8.5a3 3 0 0 0 0 5 3 3 0 0 0 2.4 4.5A3 3 0 0 0 12 19zM12 5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8.5a3 3 0 0 1 0 5 3 3 0 0 1-2.4 4.5A3 3 0 0 1 12 19z"/>',
};
function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* ------------------------- Helpers ------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Chỉ ghi innerHTML khi nội dung đổi — tránh nháy và giữ hiệu ứng thanh tiến độ khi poll 2,5s/lần. */
function setHtml(el, html) {
  if (el && el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
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

/** Thời lượng dạng chữ cho số liệu tổng: "92 giờ 15 phút". */
function fmtHours(sec) {
  sec = Math.round(Number(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} giờ ${m} phút`;
  if (h) return `${h} giờ`;
  return `${Math.max(sec ? 1 : 0, m)} phút`;
}

function fmtEta(sec) {
  if (sec == null) return "";
  return sec < 60 ? "còn dưới 1 phút" : `còn ~${fmtHours(sec)}`;
}

function fmtSize(mb) {
  mb = Number(mb || 0);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
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
    const n = m && cnToInt(m[1]);
    if (n) {
      out.episode_num = n;
      out.episode_label = String(n);
    }
  }
  if (out.episode_num == null) out._season = "other";
  else out._season = (out.publish_time || 0) >= P2_START_TS ? "p2" : "p1";

  if (out.reup_status === "reupped") out._status = "reupped";
  else if (out.local_file || out.reup_status === "downloaded") out._status = "downloaded";
  else out._status = "pending";
  return out;
}

const videoKey = (v) => v.aweme_id || `${v.title}|${v.publish_date || ""}`;

function epText(v) {
  if (!v.episode_label) return v._season === "other" ? "Video phụ" : "—";
  return `${SEASON_LABEL[v._season] || ""} · Tập ${v.episode_label}`;
}

function seasonBadge(v) {
  if (v._season === "p2") return `<span class="badge purple">Phần 2</span>`;
  if (v._season === "p1") return `<span class="badge amber">Phần 1</span>`;
  return `<span class="badge gray">Khác</span>`;
}

const statusBadge = (v) => `<span class="badge ${STATUS_TONE[v._status]}">${STATUS_LABEL[v._status]}</span>`;

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("hide"), 3800);
  setTimeout(() => el.remove(), 4200);
}

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
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
    .then(() => toast("Đã sao chép", "success"))
    .catch(() => toast("Không sao chép được, hãy copy thủ công", "error"));
}

const fileUrl = (rel) => "/" + rel.split("/").map(encodeURIComponent).join("/");
const douyinFileUrl = (file) => fileUrl(`downloads/${file}`);
const dubFileUrl = (file) => fileUrl(`downloads/dubbed/${file}`);
const projLink = (sub) => `#/project/${encodeURIComponent(state.activeProjectId)}/${sub}`;
const getActiveProject = () => state.projects.find((p) => p.id === state.activeProjectId) || null;

/* ------------------------- Data loading ------------------------- */
let dataSig = "";

async function loadAll(showToast = false) {
  try {
    const raw = await Promise.all([
      getJSON("/api/videos"),
      getJSON("/api/bilibili"),
      getJSON("/api/dubbed"),
      getJSON("/api/sources"),
      getJSON("/api/projects"),
      getJSON("/api/system"),
    ]);
    // Tiến độ job (pct/label) và dung lượng ổ đổi liên tục khi đang chạy: không tính là "dữ liệu đổi",
    // để danh sách không bị vẽ lại mỗi lần poll (thanh tiến độ được cập nhật riêng).
    const sig = JSON.stringify(raw, (k, v) => (k === "pct" || k === "label" || k === "updated_at" || k === "free_gb" ? undefined : v));
    const [vd, bili, dubbed, sources, projects, sys] = raw;
    state.sys = sys;
    if (sig === dataSig && state.loaded) {
      if (showToast) toast("Dữ liệu đã là mới nhất", "success");
      return;
    }
    dataSig = sig;
    state.videos = (vd.videos || []).map(normalizeVideo);
    state.meta = vd.channel_meta || {};
    state.source = vd.source || "";
    state.updatedAt = vd.updated_at || "";
    state.bili = bili.videos || [];
    state.dubbed = dubbed.videos || [];
    state.sources = sources.sources || [];
    state.projects = projects.projects || [];
    const firstLoad = !state.loaded;
    state.loaded = true;
    if (firstLoad) router();
    else {
      renderSidebar();
      currentPage?.update?.();
      renderTaskWidgets();
    }
    if (showToast) toast("Đã làm mới dữ liệu", "success");
  } catch (err) {
    console.error(err);
    toast("Không tải được dữ liệu từ máy chủ", "error");
  }
}

/* ------------------------- Sidebar ------------------------- */
function navLink(href, ico, label, active, count) {
  return `<a class="nav-link ${active ? "active" : ""}" href="${href}" ${active ? 'aria-current="page"' : ""}>
    ${icon(ico)}<span>${label}</span>${count != null ? `<span class="nav-count">${count}</span>` : ""}</a>`;
}

function renderSidebar() {
  const nav = $("#sidebar-nav");
  const { pid, sub } = parseRoute();
  const proj = pid ? state.projects.find((p) => p.id === pid) : null;

  if (proj) {
    const base = `#/project/${encodeURIComponent(proj.id)}`;
    nav.innerHTML = `
      <a class="sb-back" href="#/projects">${icon("back", 15)} Tất cả dự án</a>
      <div class="sb-proj">
        <div class="sb-proj-label">Dự án</div>
        <div class="sb-proj-name" title="${esc(proj.name)}">${esc(proj.name)}</div>
      </div>
      ${navLink(`${base}/videos`, "film", "Video & Lồng tiếng", sub === "videos", state.sources.length)}
      ${navLink(`${base}/douyin/list`, "list", "Kho Douyin", sub.startsWith("douyin"), state.videos.length)}
      <button class="nav-link" type="button" data-drawer="${esc(proj.id)}">${icon("brain")}<span>Ngữ cảnh AI</span>
        <span class="nav-count">${(proj.characters || []).length + (proj.glossary || []).length}</span></button>
      ${navLink(`${base}/logs`, "terminal", "Nhật ký", sub === "logs")}`;
  } else {
    const hash = location.hash.replace(/^#/, "") || "/projects";
    nav.innerHTML = `
      ${navLink("#/projects", "folder", "Dự án", hash === "/projects", state.projects.length)}
      ${navLink("#/logs", "terminal", "Nhật ký", hash === "/logs")}`;
  }
}

/* ------------------------- Task polling & widgets ------------------------- */
let lastRunning = false;
let pollTick = 0;

async function pollTask() {
  try {
    state.task = await getJSON("/api/task");
  } catch {
    return;
  }
  const t = state.task;
  renderTaskWidgets();
  pollTick++;
  if (t.running && pollTick % 4 === 0) loadAll();
  if (lastRunning && !t.running) {
    loadAll();
    const name = TASK_NAMES[t.last_type] || "Tiến trình";
    if (t.exit_code === 0) toast(`${name}: hoàn tất`, "success");
    else if (t.exit_code === 130 || t.exit_code == null) toast(`${name}: đã dừng, tiến độ được lưu lại`);
    else toast(`${name}: gặp lỗi — mở Nhật ký để xem chi tiết`, "error");
  }
  lastRunning = t.running;
}

function progressHtml(t, { steps = true } = {}) {
  const p = t.progress || {};
  const pct = Math.max(0, Math.min(100, Number(p.pct || 0)));
  const isDub = t.task_type === "dub_video" || t.task_type === "dub_rerender";
  const stepsHtml =
    steps && isDub && p.stage
      ? `<ol class="stages">${DUB_STAGES.map((s, i) => `<li class="${i + 1 < p.stage ? "done" : i + 1 === p.stage ? "active" : ""}">${s}</li>`).join("")}</ol>`
      : "";
  const eta = fmtEta(p.eta);
  return `${stepsHtml}
    <div class="progress ${pct < 0.5 ? "indet" : ""}"><div style="width:${pct}%"></div></div>
    <div class="prog-meta">
      <span class="prog-label">${esc(p.label || "Đang xử lý...")}</span>
      <span class="prog-pct">${pct >= 0.5 ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : ""}${eta ? ` · ${eta}` : ""}</span>
    </div>`;
}

function renderTaskWidgets() {
  const t = state.task || {};
  const name = TASK_NAMES[t.running ? t.task_type : t.last_type] || "";
  const logsHref = state.activeProjectId && parseRoute().pid ? projLink("logs") : "#/logs";

  // Khung tiến trình ở chân sidebar + đầu trang Nhật ký
  $$(".js-task").forEach((el) => {
    let html;
    if (t.running) {
      html = `
        <div class="task-card busy">
          <div class="task-head"><span class="dot"></span><b>${esc(name)}</b></div>
          ${progressHtml(t, { steps: el.dataset.variant !== "sidebar" })}
          <div class="task-actions">
            ${el.dataset.variant === "sidebar" ? `<a class="btn btn-quiet btn-sm" href="${logsHref}">Nhật ký</a>` : ""}
            <button class="btn btn-danger btn-sm" type="button" data-stop>${icon("stop", 14)} Dừng</button>
          </div>
        </div>`;
    } else if (t.last_type) {
      const ok = t.exit_code === 0;
      const stopped = t.exit_code === 130 || t.exit_code == null;
      html = `
        <div class="task-card ${ok ? "ok" : stopped ? "" : "err"}">
          <div class="task-head"><span class="dot"></span><b>${esc(name)}</b></div>
          <div class="task-result">${ok ? "Đã hoàn tất" : stopped ? "Đã dừng — tiến độ được lưu" : `Gặp lỗi — <a href="${logsHref}">xem nhật ký</a>`}</div>
        </div>`;
    } else {
      html = `<div class="task-card"><div class="task-head"><span class="dot"></span><span>Sẵn sàng</span></div></div>`;
    }
    setHtml(el, html);
  });

  const chip = $("#task-chip");
  chip.hidden = !t.running;
  if (t.running) {
    chip.href = logsHref;
    setHtml(chip, `<span class="dot"></span><span class="chip-name">${esc(name)} ·</span> ${Math.round(Number(t.progress?.pct || 0))}%`);
  }

  $$(".js-log").forEach((el) => {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    const text = (t.logs || []).join("\n") || "Chưa có nhật ký. Khi bạn bấm tải, quét hoặc lồng tiếng, tiến trình sẽ hiện ở đây.";
    if (el._text !== text) {
      el.textContent = text;
      el._text = text;
      if (atBottom) el.scrollTop = el.scrollHeight;
    }
  });

  $$(".js-busy-disable").forEach((el) => (el.disabled = !!t.running));

  // Tiến độ hiện ngay tại dòng video đang được xử lý
  $$(".js-vid-prog").forEach((box) => {
    const match = t.running && t.target && (t.target === box.dataset.target || t.target === box.dataset.job);
    box.closest(".vrow")?.classList.toggle("is-running", !!match);
    setHtml(box, match ? progressHtml(t) : "");
  });

  // Tiến độ tải video mới (chưa có dòng nào trong danh sách để gắn vào)
  $$(".js-task-inline").forEach((box) => {
    const match = t.running && t.task_type === box.dataset.type;
    box.hidden = !match;
    setHtml(box, match ? `<div class="inline-task"><b>${icon("download", 16)} ${esc(name)}</b>${progressHtml(t)}</div>` : "");
  });
}

async function stopTask() {
  await postJSON("/api/task/stop");
  toast("Đang dừng tiến trình...");
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
  await pollTask();
  return true;
}

/* ------------------------- Modal ------------------------- */
function openModal(title, bodyHtml, { size = "", sticky = false, beforeClose = null } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-bg">
      <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <h3 title="${esc(title)}">${esc(title)}</h3>
          <button class="icon-btn" type="button" data-close aria-label="Đóng">${icon("x")}</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const bg = root.firstElementChild;
  const onKey = (e) => e.key === "Escape" && close();
  function close(force = false) {
    if (!force && beforeClose && !beforeClose()) return;
    $$("video", root).forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  }
  bg.addEventListener("click", (e) => {
    if ((e.target === bg && !sticky) || e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  renderTaskWidgets();
  return { el: bg, close };
}

function openPlayer(src, title) {
  openModal(title, `<video class="player" src="${esc(src)}" controls autoplay></video>`, { size: "wide" });
}

/* ------------------------- Shared UI pieces ------------------------- */
function metric(ico, label, value, sub = "", tone = "") {
  return `
    <div class="metric ${tone}">
      <div class="metric-ico">${icon(ico, 20)}</div>
      <div class="metric-body">
        <div class="metric-label">${label}</div>
        <div class="metric-val">${value}</div>
        ${sub ? `<div class="metric-sub">${sub}</div>` : ""}
      </div>
    </div>`;
}

function emptyState(ico, title, desc, actionHtml = "") {
  return `
    <div class="empty">
      <div class="empty-ico">${icon(ico, 26)}</div>
      <h4>${title}</h4>
      <p>${desc}</p>
      ${actionHtml}
    </div>`;
}

function callout(tone, ico, html) {
  return `<div class="callout ${tone}">${icon(ico, 17)}<div>${html}</div></div>`;
}

function thumbImg(url, alt = "") {
  return url
    ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : "";
}

const options = (list, selected) =>
  list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(label)}</option>`).join("");

/* =========================================================
   TRANG: DỰ ÁN
   ========================================================= */
function openNewProjectModal() {
  const html = `
    <div class="field">
      <label for="np-name">Tên dự án (tên bộ truyện / phim)</label>
      <input id="np-name" class="input" type="text" placeholder="Ví dụ: Đấu Phá Thương Khung" />
    </div>
    <div class="form-grid">
      <div class="field">
        <label for="np-type">Thể loại</label>
        <select id="np-type" class="select">
          ${options(["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"].map((t) => [t, t]))}
        </select>
      </div>
      <div class="field">
        <label for="np-style">Phong cách dịch</label>
        <input id="np-style" class="input" type="text" value="Tự nhiên, gần gũi, giữ đúng xưng hô" />
      </div>
    </div>
    <div class="field">
      <label for="np-syn">Bối cảnh / cốt truyện</label>
      <textarea id="np-syn" class="input" rows="4" placeholder="Nhân vật chính, bối cảnh, quan hệ giữa các nhân vật... AI đọc phần này mỗi lần dịch."></textarea>
    </div>
    <div class="modal-foot">
      <button class="btn btn-light" type="button" data-close>Hủy</button>
      <button class="btn btn-primary" type="button" id="np-create">${icon("plus", 16)} Tạo dự án</button>
    </div>`;
  const { el, close } = openModal("Tạo dự án mới", html);
  $("#np-name", el).focus();
  $("#np-create", el).onclick = async () => {
    const name = $("#np-name", el).value.trim();
    if (!name) return toast("Vui lòng nhập tên dự án", "error");
    const d = await postJSON("/api/projects", {
      name,
      type: $("#np-type", el).value,
      style: $("#np-style", el).value.trim(),
      synopsis: $("#np-syn", el).value.trim(),
    });
    if (!d.ok) return toast(d.error || "Không tạo được dự án", "error");
    toast(`Đã tạo dự án "${name}"`, "success");
    close(true);
    await loadAll();
    location.hash = `#/project/${encodeURIComponent(d.project.id)}/videos`;
  };
}

function PageProjects() {
  function draw() {
    const totalSec = state.dubbed.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
    const totalMem = state.projects.reduce((a, p) => a + (p.characters || []).length + (p.glossary || []).length, 0);

    $("#pj-metrics").innerHTML = [
      metric("folder", "Dự án", state.projects.length, "", "violet"),
      metric("mic", "Video đã lồng tiếng", state.dubbed.length, totalSec ? `Tổng ${fmtHours(totalSec)}` : "", "green"),
      metric("brain", "AI đã ghi nhớ", totalMem, "nhân vật & thuật ngữ", "pink"),
      metric("disk", "Ổ cứng còn trống", `${state.sys.free_gb || 0} GB`, `trên ${state.sys.total_gb || 0} GB`, "blue"),
    ].join("");

    const cards = state.projects.map((p) => `
      <article class="pcard" data-open="${esc(p.id)}" tabindex="0" role="link" aria-label="Mở dự án ${esc(p.name)}">
        <div class="pcard-top">
          <div class="pcard-ico">${icon(p.type?.includes("Phim") ? "film" : p.type?.includes("Review") ? "book" : "sparkles", 22)}</div>
          <div class="pcard-head">
            <div class="pcard-title">${esc(p.name)}</div>
            <span class="badge violet">${esc(p.type || "Truyện / Hoạt hình")}</span>
          </div>
          <button class="icon-btn" type="button" data-cfg="${esc(p.id)}" title="Ngữ cảnh AI & cài đặt dự án">${icon("sliders")}</button>
        </div>
        <p class="pcard-syn">${esc(p.synopsis || "Chưa có mô tả cốt truyện. Thêm bối cảnh để AI dịch đúng mạch truyện hơn.")}</p>
        <div class="pcard-foot">
          <span>${icon("mic", 14)} ${p.video_count || 0} video</span>
          <span>${icon("users", 14)} ${(p.characters || []).length} nhân vật</span>
          <span>${icon("book", 14)} ${(p.glossary || []).length} thuật ngữ</span>
          <span class="pcard-go">Mở ${icon("chevron", 15)}</span>
        </div>
      </article>`).join("");

    $("#pj-grid").innerHTML = `
      <div class="proj-grid">
        ${cards}
        <button class="pcard pcard-new" type="button" data-new>
          <span class="plus">${icon("plus", 22)}</span>
          <b>Tạo dự án mới</b>
          <span>Mỗi bộ truyện / phim một dự án để AI nhớ nhân vật, xưng hô và mạch truyện</span>
        </button>
      </div>`;
  }

  return {
    render: () => `<div class="metrics" id="pj-metrics"></div><div id="pj-grid"></div>`,
    mount() {
      const open = (id) => (location.hash = `#/project/${encodeURIComponent(id)}/videos`);
      $("#pj-grid").onclick = (e) => {
        if (e.target.closest("[data-new]")) return openNewProjectModal();
        const cfg = e.target.closest("[data-cfg]");
        if (cfg) return openProjectDrawer(cfg.dataset.cfg);
        const card = e.target.closest("[data-open]");
        if (card) open(card.dataset.open);
      };
      $("#pj-grid").onkeydown = (e) => {
        if (e.key === "Enter" && e.target.matches("[data-open]")) open(e.target.dataset.open);
      };
    },
    update: draw,
  };
}

/* =========================================================
   NGĂN TRƯỢT: NGỮ CẢNH AI & CÀI ĐẶT DỰ ÁN
   ========================================================= */
function openProjectDrawer(projectId, initialTab = "info") {
  const proj = state.projects.find((p) => p.id === projectId) || getActiveProject();
  if (!proj) return toast("Chưa chọn dự án nào", "error");

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
      draft.name = $("#dr-name", root).value.trim();
      draft.type = $("#dr-type", root).value;
      draft.style = $("#dr-style", root).value.trim();
      draft.synopsis = $("#dr-syn", root).value.trim();
    } else if (activeTab === "chars") {
      draft.characters = $$("#dr-rows tr[data-i]", root).map((tr) => ({
        zh: $(".c-zh", tr).value.trim(),
        vi: $(".c-vi", tr).value.trim(),
        pronouns: $(".c-pr", tr).value.trim(),
        role: (draft.characters[Number(tr.dataset.i)] || {}).role || "",
      }));
    } else if (activeTab === "gloss") {
      draft.glossary = $$("#dr-rows tr[data-i]", root).map((tr) => ({
        zh: $(".c-zh", tr).value.trim(),
        vi: $(".c-vi", tr).value.trim(),
      }));
    } else if (activeTab === "notes") {
      $$(".dr-ep-note", root).forEach((inp) => (draft.episode_notes[inp.dataset.job] = inp.value.trim()));
    }
  }

  /** Bảng sửa nhanh dùng chung cho Nhân vật và Từ điển. */
  function tableTab(key, hint, cols, emptyText, blank) {
    const rows = draft[key];
    return `
      <div class="drawer-bar">
        <span class="muted">${hint}</span>
        <button class="btn btn-light btn-sm" type="button" data-add="${key}">${icon("plus", 14)} Thêm</button>
      </div>
      <div class="table-wrap bordered">
        <table class="tbl compact">
          <thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join("")}<th></th></tr></thead>
          <tbody id="dr-rows">
            ${rows.map((r, i) => `
              <tr data-i="${i}">
                ${cols.map((c) => `<td><input class="input input-sm ${c[0]}" value="${esc(r[c[2]] || "")}" aria-label="${c[1]}" /></td>`).join("")}
                <td><button class="icon-btn danger" type="button" data-rm="${key}:${i}" title="Xóa dòng">${icon("x", 15)}</button></td>
              </tr>`).join("") || `<tr><td colspan="${cols.length + 1}" class="muted">${emptyText}</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  function renderBody() {
    const body = $("#dr-body", root);
    $$(".tabs button", root).forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));

    if (activeTab === "info") {
      body.innerHTML = `
        <div class="field"><label for="dr-name">Tên dự án</label><input id="dr-name" class="input" value="${esc(draft.name)}" /></div>
        <div class="field"><label for="dr-type">Thể loại</label>
          <select id="dr-type" class="select">${options(["Truyện / Hoạt hình", "Phim bộ", "Phim lẻ", "Review / Tài liệu"].map((t) => [t, t]), draft.type)}</select></div>
        <div class="field"><label for="dr-style">Phong cách dịch & giọng văn</label><input id="dr-style" class="input" value="${esc(draft.style)}" /></div>
        <div class="field"><label for="dr-syn">Cốt truyện chung</label><textarea id="dr-syn" class="input" rows="6">${esc(draft.synopsis)}</textarea></div>
        ${callout("info", "brain", "Mỗi lần dịch, AI đọc toàn bộ ngữ cảnh này, rồi tự bổ sung nhân vật và thuật ngữ mới gặp vào dự án.")}`;
    } else if (activeTab === "chars") {
      body.innerHTML = tableTab("characters", "AI tự thêm khi gặp nhân vật mới — bạn có thể sửa tên và xưng hô.",
        [["c-zh", "Tên gốc", "zh"], ["c-vi", "Tên Việt", "vi"], ["c-pr", "Xưng hô", "pronouns"]], "Chưa có nhân vật.");
    } else if (activeTab === "gloss") {
      body.innerHTML = tableTab("glossary", "Thuật ngữ, chiêu thức, từ lóng riêng của bộ này.",
        [["c-zh", "Từ gốc", "zh"], ["c-vi", "Dịch tiếng Việt", "vi"]], "Chưa có thuật ngữ.");
    } else {
      body.innerHTML = draft.videos.length
        ? draft.videos.map((v, i) => `
            <div class="field">
              <label for="ep-${i}">${i + 1}. ${esc(v.title)}</label>
              <textarea id="ep-${i}" class="input dr-ep-note" data-job="${esc(v.job_id)}" rows="3">${esc(draft.episode_notes[v.job_id] || "")}</textarea>
            </div>`).join("")
        : `<p class="muted">Chưa có video nào được lồng tiếng trong dự án này. Sau mỗi video, AI tự ghi tóm tắt diễn biến ở đây để giữ mạch truyện cho video sau.</p>`;
    }
  }

  function closeDrawer() {
    root.innerHTML = "";
    document.removeEventListener("keydown", onEsc);
  }
  const onEsc = (e) => e.key === "Escape" && closeDrawer();

  root.innerHTML = `
    <div class="drawer-bg">
      <div class="drawer" role="dialog" aria-modal="true" aria-label="Ngữ cảnh AI của dự án">
        <div class="drawer-head">
          <h3>Ngữ cảnh AI · ${esc(draft.name)}</h3>
          <button class="icon-btn" type="button" data-close aria-label="Đóng">${icon("x")}</button>
        </div>
        <div class="tabs">
          <button type="button" data-tab="info">Thông tin</button>
          <button type="button" data-tab="chars">Nhân vật <span class="cnt">${draft.characters.length}</span></button>
          <button type="button" data-tab="gloss">Từ điển <span class="cnt">${draft.glossary.length}</span></button>
          <button type="button" data-tab="notes">Mạch truyện <span class="cnt">${draft.videos.length}</span></button>
        </div>
        <div class="drawer-body" id="dr-body"></div>
        <div class="drawer-foot">
          <button class="btn btn-quiet btn-sm danger" type="button" id="dr-del">${icon("trash", 15)} Xóa dự án</button>
          <span class="grow"></span>
          <button class="btn btn-light" type="button" id="dr-copy">${icon("copy", 15)} Copy ngữ cảnh</button>
          <button class="btn btn-primary" type="button" id="dr-save">Lưu</button>
        </div>
      </div>
    </div>`;

  renderBody();
  document.addEventListener("keydown", onEsc);

  root.firstElementChild.onclick = (e) => {
    if (e.target === root.firstElementChild || e.target.closest("[data-close]")) return closeDrawer();
    const tab = e.target.closest("[data-tab]");
    const add = e.target.closest("[data-add]");
    const rm = e.target.closest("[data-rm]");
    if (!tab && !add && !rm) return;
    syncTabInputs();
    if (tab) activeTab = tab.dataset.tab;
    if (add) draft[add.dataset.add].push({ zh: "", vi: "", pronouns: "", role: "" });
    if (rm) {
      const [key, i] = rm.dataset.rm.split(":");
      draft[key].splice(Number(i), 1);
    }
    renderBody();
    if (add) $("#dr-rows tr:last-child input", root)?.focus();
  };
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
      glossary: draft.glossary.filter((g) => g.zh || g.vi).map(({ zh, vi }) => ({ zh, vi })),
      episode_notes: draft.episode_notes,
    });
    if (!d.ok) return toast(d.error || "Lưu thất bại", "error");
    toast("Đã lưu ngữ cảnh dự án", "success");
    closeDrawer();
    loadAll();
  };
  $("#dr-del", root).onclick = async () => {
    if (!confirm(`Xóa dự án "${draft.name}"?\n\nCác file video vẫn được giữ nguyên, chỉ mất ngữ cảnh AI của dự án.`)) return;
    await postJSON("/api/projects/delete", { id: draft.id });
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

/* =========================================================
   TRANG: VIDEO & LỒNG TIẾNG (tải video + thư viện + lồng tiếng trong 1 nơi)
   ========================================================= */
function buildWorkspaceItems() {
  const dubByTitle = new Map(state.dubbed.map((d) => [d.title, d]));
  const biliByFile = new Map(state.bili.map((b) => [b.local_file, b]));
  return state.sources.map((s) => {
    const meta = biliByFile.get(s.name) || {};
    const dub = dubByTitle.get(s.name) || null;
    const job = s.job && s.job.status !== "done" ? s.job : null;
    return {
      ...s,
      title: meta.title || s.name,
      uploader: meta.uploader || "",
      delogo: meta.delogo || "none",
      video_src: fileUrl(s.rel_path),
      dub,
      job,
      status: job ? "partial" : dub ? "dubbed" : "new",
    };
  });
}

function openAddVideoModal() {
  const presets = [
    ["Hợp tuyển tập 151–200 (~5 tiếng)", "https://www.bilibili.com/video/BV1teKEzeEfZ/"],
    ["Tập lẻ 84 giây (thử nhanh)", "https://www.bilibili.com/video/BV1nHW3z3EhH/"],
  ];
  const logoOpts = [
    ["none", "Không xóa lúc tải", "Nhanh nhất. Xóa logo sau, ngay trong bước lồng tiếng", []],
    ["top-right", "Góc trên phải", "Thường gặp ở video ngang", ["r"]],
    ["top-left", "Góc trên trái", "Thường gặp ở video dọc", ["l"]],
    ["both-top", "Cả 2 góc trên", "Khi không chắc vị trí", ["l", "r"]],
  ];
  const html = `
    <div class="field">
      <label for="av-url">Link Bilibili hoặc YouTube</label>
      <input id="av-url" class="input" type="url" placeholder="https://www.bilibili.com/video/BV..." />
      <div class="chips">${presets.map(([l, u]) => `<button class="chip" type="button" data-url="${esc(u)}">${esc(l)}</button>`).join("")}</div>
    </div>

    <div class="form-grid">
      <fieldset class="group">
        <legend>Chỉ tải một đoạn <span class="muted">(tùy chọn)</span></legend>
        <div class="range-row">
          <input id="av-from" class="input" type="text" placeholder="00:00:00" aria-label="Từ giờ" />
          <span class="muted">→</span>
          <input id="av-to" class="input" type="text" placeholder="01:00:00" aria-label="Đến giờ" />
        </div>
        <div class="chips">
          <button class="chip" type="button" data-sec="00:00:00,00:15:00">15 phút đầu</button>
          <button class="chip" type="button" data-sec="00:00:00,01:00:00">Giờ thứ 1</button>
          <button class="chip" type="button" data-sec="01:00:00,02:00:00">Giờ thứ 2</button>
          <button class="chip" type="button" data-sec=",">Cả video</button>
        </div>
        <div class="help">Để trống = tải trọn video. Video 9–90 tiếng vẫn tải trọn được, bị rớt mạng sẽ tự nối tiếp.</div>
      </fieldset>
      <fieldset class="group">
        <legend>Link nhiều phần (P1, P2...) <span class="muted">(tùy chọn)</span></legend>
        <input id="av-pitems" class="input" type="text" placeholder="Ví dụ: 1-5 hoặc 1,3,5" aria-label="Chọn Part" />
        <label class="check"><input id="av-playlist" type="checkbox" /> Tải tất cả các phần</label>
        <div class="help">Mỗi phần thành 1 video riêng trong danh sách.</div>
      </fieldset>
    </div>

    <div class="field">
      <span class="label">Logo của nền tảng</span>
      <div class="opt-grid" id="av-delogo">
        ${logoOpts.map(([v, title, desc, marks], i) => `
          <label class="opt ${i === 0 ? "checked" : ""}">
            <input type="radio" name="av-delogo" value="${v}" ${i === 0 ? "checked" : ""} />
            <span class="screen">${marks.map((m) => `<span class="mark ${m}"></span>`).join("")}</span>
            <span class="opt-title">${title}</span>
            <span class="opt-desc">${desc}</span>
          </label>`).join("")}
      </div>
    </div>

    <div class="form-grid">
      <div class="field">
        <label for="av-quality">Độ phân giải</label>
        <select id="av-quality" class="select">
          <option value="720p">Tối đa 720p — nhẹ bằng nửa, hợp video dài</option>
          <option value="best">Cao nhất (1080p trở lên)</option>
        </select>
      </div>
      <div class="field">
        <label for="av-perf">Mức dùng máy khi xóa logo</label>
        <select id="av-perf" class="select">
          <option value="balanced">Cân bằng — 50% CPU</option>
          <option value="eco">Mát máy — 30% CPU</option>
          <option value="fast">Tối đa — nhanh nhất</option>
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <span class="muted">${icon("disk", 15)} Ổ cứng còn trống ${state.sys.free_gb || 0} GB</span>
      <span class="grow"></span>
      <button class="btn btn-light" type="button" data-close>Hủy</button>
      <button class="btn btn-primary js-busy-disable" type="button" id="av-start">${icon("download", 16)} Bắt đầu tải</button>
    </div>`;

  const { el, close } = openModal("Thêm video từ Bilibili / YouTube", html, { size: "wide" });
  $("#av-url", el).focus();
  el.addEventListener("click", (e) => {
    const u = e.target.closest("[data-url]");
    if (u) $("#av-url", el).value = u.dataset.url;
    const s = e.target.closest("[data-sec]");
    if (s) [$("#av-from", el).value, $("#av-to", el).value] = s.dataset.sec.split(",");
  });
  $("#av-delogo", el).onchange = () =>
    $$("#av-delogo .opt", el).forEach((o) => o.classList.toggle("checked", $("input", o).checked));
  $("#av-start", el).onclick = async () => {
    const url = $("#av-url", el).value.trim();
    if (!url) {
      toast("Vui lòng dán link Bilibili hoặc YouTube", "error");
      return $("#av-url", el).focus();
    }
    const from = $("#av-from", el).value.trim();
    const to = $("#av-to", el).value.trim();
    if (Boolean(from) !== Boolean(to)) return toast("Nhập đủ cả giờ bắt đầu và giờ kết thúc, hoặc để trống cả hai", "error");
    const section = from && to ? `${from}-${to}` : "";
    const ok = await startTask(
      "/api/bilibili/download",
      {
        url,
        section,
        playlist_items: $("#av-pitems", el).value.trim(),
        playlist: $("#av-playlist", el).checked,
        quality: $("#av-quality", el).value,
        delogo: $("#av-delogo input:checked", el).value,
        perf: $("#av-perf", el).value,
      },
      section ? `Bắt đầu tải đoạn ${section}` : "Bắt đầu tải video"
    );
    if (ok) close(true);
  };
}

function openDelogoModal(v) {
  const html = `
    ${callout("info", "info", "Xóa logo riêng phải mã hóa lại cả video. Nếu bạn sắp lồng tiếng video này, hãy bật <b>Xóa logo</b> trong bước lồng tiếng để chỉ mã hóa một lần.")}
    <div class="form-grid">
      <div class="field">
        <label for="md-delogo">Vị trí logo</label>
        <select id="md-delogo" class="select">${options(DELOGO_OPTIONS.slice(1), "top-right")}</select>
      </div>
      <div class="field">
        <label for="md-perf">Mức dùng máy</label>
        <select id="md-perf" class="select">
          <option value="balanced">Cân bằng — 50% CPU</option>
          <option value="eco">Mát máy — 30% CPU</option>
          <option value="fast">Tối đa — nhanh nhất</option>
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-light" type="button" data-close>Hủy</button>
      <button class="btn btn-primary js-busy-disable" type="button" id="md-run">${icon("sparkles", 16)} Xóa logo</button>
    </div>`;
  const { el, close } = openModal(`Xóa logo · ${v.title}`, html);
  $("#md-run", el).onclick = async () => {
    const ok = await startTask(
      "/api/bilibili/delogo",
      { local_file: v.name, delogo: $("#md-delogo", el).value, perf: $("#md-perf", el).value },
      "Đang xóa logo"
    );
    if (ok) close(true);
  };
}

function openDeleteVideoModal(v) {
  const jobId = v.dub?.job_id || "";
  const html = `
    ${callout("danger", "alert", "<b>File sẽ bị xóa vĩnh viễn khỏi ổ cứng</b> và không khôi phục được.")}
    <div class="file-box">
      <b>${esc(v.title)}</b>
      <code>${esc(v.rel_path)}</code>
      <span class="muted">${fmtSize(v.size_mb)}${v.duration_sec ? ` · ${fmtDur(v.duration_sec)}` : ""}</span>
    </div>
    ${jobId ? `<label class="check"><input id="del-dub" type="checkbox" checked /> Xóa luôn bản lồng tiếng Việt, phụ đề và cache</label>` : ""}
    <div class="modal-foot">
      <button class="btn btn-light" type="button" data-close>Hủy</button>
      <button class="btn btn-danger" type="button" id="del-ok">${icon("trash", 16)} Xóa vĩnh viễn</button>
    </div>`;
  const { el, close } = openModal("Xóa video", html);
  $("#del-ok", el).onclick = async () => {
    const btn = $("#del-ok", el);
    btn.disabled = true;
    const d = await postJSON("/api/source/delete", {
      rel_path: v.rel_path,
      job_id: jobId,
      delete_dubbed: jobId ? $("#del-dub", el).checked : false,
    });
    if (d.ok) {
      toast("Đã xóa video", "success");
      close(true);
      loadAll();
    } else {
      toast(d.error || "Không xóa được video", "error");
      btn.disabled = false;
    }
  };
}

function openDubConfigModal(v) {
  const proj = getActiveProject();
  const prev = v.job?.params || v.dub || {};
  const sel = (key, fallback) => prev[key] ?? fallback;
  const resumable = v.job && v.job.status !== "done";
  const html = `
    ${resumable
      ? callout("warn", "clock", `Video này đang làm dở ở <b>${Math.round(v.job.pct)}%</b>. Bấm bắt đầu sẽ <b>chạy tiếp</b> từ chỗ đang dở.
          <label class="check" style="margin-top:8px"><input id="mc-fresh" type="checkbox" /> Bỏ kết quả dở, nhận diện và dịch lại từ đầu</label>`)
      : callout("info", "brain", `Dự án <b>${esc(proj?.name || "—")}</b>: AI đọc ngữ cảnh dự án, tự sửa lỗi nghe nhầm, dịch đúng xưng hô và ghi nhớ nhân vật mới.`)}
    <div class="form-grid">
      <div class="field">
        <label for="mc-voice">Giọng lồng tiếng</label>
        <select id="mc-voice" class="select">${options(VOICES, sel("voice", VOICES[0][0]))}</select>
      </div>
      <div class="field">
        <label for="mc-model">Độ chính xác nhận diện</label>
        <select id="mc-model" class="select">
          ${options([["base", "Nhanh (base) — hợp video dài"], ["small", "Chính xác hơn (small) — chậm gấp ~3"]], sel("model", "base"))}
        </select>
      </div>
      <div class="field">
        <label for="mc-speed">Làm chậm khi tách lời</label>
        <select id="mc-speed" class="select">
          ${options([["0.5", "0.5x — thoại nhanh, nói dồn dập"], ["0.65", "0.65x"], ["0.8", "0.8x"], ["1", "1.0x — không làm chậm, nhanh gấp đôi"]], sel("speed", 0.5))}
        </select>
        <div class="help">Chỉ ảnh hưởng bước nhận diện. Video xuất ra luôn ở tốc độ gốc.</div>
      </div>
      <div class="field">
        <label for="mc-bg">Âm thanh gốc làm nền</label>
        <select id="mc-bg" class="select">
          ${options([["0.05", "5% — rất nhỏ"], ["0", "Tắt hẳn"], ["0.12", "12% — rõ tiếng động nền"]], sel("bg_volume", 0.05))}
        </select>
      </div>
      <div class="field">
        <label for="mc-delogo">Xóa logo khi xuất</label>
        <select id="mc-delogo" class="select">${options(DELOGO_OPTIONS, sel("delogo", "none"))}</select>
      </div>
      <div class="field">
        <span class="label">Phụ đề</span>
        <label class="check"><input id="mc-sub" type="checkbox" ${sel("burn_sub", true) !== false ? "checked" : ""} /> In cứng phụ đề Việt nền đen (che chữ Trung)</label>
        <div class="help">Tắt cả phụ đề lẫn xóa logo thì video được giữ nguyên hình, xuất gần như tức thì.</div>
      </div>
    </div>
    <div id="mc-est"></div>
    <div class="modal-foot">
      <button class="btn btn-light" type="button" data-close>Hủy</button>
      <button class="btn btn-primary js-busy-disable" type="button" id="mc-run">${icon("mic", 16)} ${resumable ? "Tiếp tục lồng tiếng" : "Bắt đầu lồng tiếng"}</button>
    </div>`;

  const { el, close } = openModal(`Lồng tiếng · ${v.title}`, html, { size: "wide" });

  // Ước tính sơ bộ theo máy 8 nhân: chỉ để người dùng biết nên để máy chạy qua đêm hay không.
  function drawEstimate() {
    const dur = Number(v.duration_sec || 0);
    const encode = $("#mc-sub", el).checked || $("#mc-delogo", el).value !== "none";
    const slow = 0.5 / Number($("#mc-speed", el).value);
    const factor = ($("#mc-model", el).value === "small" ? 0.75 : 0.25) * slow + (encode ? 0.3 : 0.03) + 0.08;
    const needGb = (v.size_mb / 1024) * (encode ? 2.2 : 1.15) + 0.5;
    const lowDisk = state.sys.free_gb && state.sys.free_gb < needGb;
    $("#mc-est", el).innerHTML = [
      dur > 600 ? callout("info", "clock", `Video dài <b>${fmtHours(dur)}</b> — ước tính xử lý khoảng <b>${fmtHours(dur * factor)}</b> (tùy máy và mạng).
        Tiến độ được lưu liên tục: dừng, tắt máy hay mất mạng đều <b>chạy tiếp được</b> từ chỗ đang dở.`) : "",
      lowDisk ? callout("danger", "disk", `Cần khoảng <b>${needGb.toFixed(1)} GB</b> trống nhưng ổ cứng chỉ còn <b>${state.sys.free_gb} GB</b>. Hãy xóa bớt video cũ${encode ? " hoặc tắt in phụ đề / xóa logo" : ""}.`) : "",
    ].join("");
  }
  ["mc-model", "mc-speed", "mc-delogo", "mc-sub"].forEach((id) => ($("#" + id, el).onchange = drawEstimate));
  drawEstimate();

  $("#mc-run", el).onclick = async () => {
    const ok = await startTask(
      "/api/dub/start",
      {
        project_id: state.activeProjectId || "",
        rel_path: v.rel_path,
        speed: Number($("#mc-speed", el).value),
        voice: $("#mc-voice", el).value,
        model: $("#mc-model", el).value,
        bg_volume: Number($("#mc-bg", el).value),
        delogo: $("#mc-delogo", el).value,
        burn_sub: $("#mc-sub", el).checked,
        fresh: $("#mc-fresh", el)?.checked || false,
      },
      resumable ? "Đang chạy tiếp từ chỗ đang dở" : "Đã bắt đầu dịch & lồng tiếng"
    );
    if (ok) close(true);
  };
}

/** Sửa lời dịch: phân trang phía server nên video 90 tiếng (>100k câu) vẫn mở tức thì. */
async function openDubEditorModal(jobId) {
  const st = { offset: 0, limit: 100, q: "", only: "", edits: {}, info: null };
  const editCount = () => Object.keys(st.edits).length;
  const html = `
    <div class="editor">
      <div class="editor-side">
        <video class="editor-video" controls preload="metadata"></video>
        <div class="help">Bấm vào mốc giờ của một câu để nghe lại đúng đoạn đó.</div>
        <div class="field"><label for="ed-voice">Giọng đọc</label><select id="ed-voice" class="select"></select></div>
        <div class="field"><label for="ed-delogo">Xóa logo</label><select id="ed-delogo" class="select"></select></div>
        <label class="check"><input id="ed-sub" type="checkbox" /> In cứng phụ đề lên video</label>
      </div>
      <div class="editor-main">
        <div class="toolbar">
          <input id="ed-q" class="input" type="search" placeholder="Tìm trong lời Việt hoặc tiếng Trung..." aria-label="Tìm câu thoại" />
          <label class="check"><input id="ed-empty" type="checkbox" /> Chỉ câu chưa dịch <span class="cnt" id="ed-empty-n">0</span></label>
        </div>
        <div class="table-wrap bordered editor-table">
          <table class="tbl compact">
            <thead><tr><th>Mốc giờ</th><th>Tiếng Trung gốc</th><th>Lời Việt (sửa trực tiếp)</th></tr></thead>
            <tbody id="ed-rows"><tr><td colspan="3" class="muted">Đang tải...</td></tr></tbody>
          </table>
        </div>
        <div class="editor-pager">
          <button class="btn btn-light btn-sm" type="button" id="ed-prev">‹ Trước</button>
          <span class="muted" id="ed-range"></span>
          <button class="btn btn-light btn-sm" type="button" id="ed-next">Sau ›</button>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="muted" id="ed-count">Chưa sửa câu nào</span>
      <span class="grow"></span>
      <button class="btn btn-light" type="button" data-close>Đóng</button>
      <button class="btn btn-primary js-busy-disable" type="button" id="ed-save">${icon("mic", 16)} Lưu & xuất lại</button>
    </div>`;

  const { el, close } = openModal("Sửa lời dịch", html, {
    size: "xl",
    sticky: true,
    beforeClose: () => !editCount() || confirm(`Bạn đã sửa ${editCount()} câu nhưng chưa xuất lại. Đóng và bỏ các chỉnh sửa?`),
  });

  async function load() {
    const params = new URLSearchParams({ id: jobId, offset: st.offset, limit: st.limit, q: st.q, only: st.only });
    const d = await getJSON("/api/dub/segments?" + params);
    if (d.error) {
      toast(d.error, "error");
      return close(true);
    }
    if (!st.info) {
      // Lần đầu: điền thông tin cố định của bản lồng tiếng
      $(".modal-head h3", el).textContent = `Sửa lời dịch · ${d.title}`;
      $(".editor-video", el).src = dubFileUrl(`${jobId}.mp4`);
      $("#ed-voice", el).innerHTML = options(VOICES, d.voice);
      $("#ed-delogo", el).innerHTML = options(DELOGO_OPTIONS, d.delogo || "none");
      $("#ed-sub", el).checked = d.burn_sub !== false;
    }
    st.info = d;
    $("#ed-empty-n", el).textContent = d.empty;
    $("#ed-rows", el).innerHTML =
      d.items.map((s) => {
        const edited = String(s.id) in st.edits;
        return `
          <tr data-id="${s.id}" class="${edited ? "edited" : ""}">
            <td><button class="time-btn" type="button" data-seek="${s.start}" title="Phát từ mốc này">${fmtDur(s.start) || "0:00"}</button></td>
            <td class="zh">${esc(s.zh)}</td>
            <td><input class="input input-sm seg-vi" type="text" value="${esc(edited ? st.edits[s.id] : s.vi)}" data-orig="${esc(s.vi)}" aria-label="Lời Việt câu ${s.id}" /></td>
          </tr>`;
      }).join("") || `<tr><td colspan="3" class="muted">Không có câu nào khớp.</td></tr>`;
    $("#ed-range", el).textContent = d.matched
      ? `${(d.offset + 1).toLocaleString("vi")}–${(d.offset + d.items.length).toLocaleString("vi")} / ${d.matched.toLocaleString("vi")} câu`
      : "0 câu";
    $("#ed-prev", el).disabled = d.offset <= 0;
    $("#ed-next", el).disabled = d.offset + d.items.length >= d.matched;
    $(".editor-table", el).scrollTop = 0;
  }

  $("#ed-rows", el).addEventListener("input", (e) => {
    const inp = e.target.closest(".seg-vi");
    if (!inp) return;
    const tr = inp.closest("tr");
    const changed = inp.value.trim() !== inp.dataset.orig;
    if (changed) st.edits[tr.dataset.id] = inp.value.trim();
    else delete st.edits[tr.dataset.id];
    tr.classList.toggle("edited", changed);
    $("#ed-count", el).textContent = editCount() ? `Đã sửa ${editCount()} câu` : "Chưa sửa câu nào";
  });
  $("#ed-rows", el).addEventListener("click", (e) => {
    const b = e.target.closest("[data-seek]");
    if (!b) return;
    const video = $(".editor-video", el);
    video.currentTime = Number(b.dataset.seek);
    video.play();
  });
  let qTimer;
  $("#ed-q", el).oninput = (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      st.q = e.target.value;
      st.offset = 0;
      load();
    }, 250);
  };
  $("#ed-empty", el).onchange = (e) => {
    st.only = e.target.checked ? "empty" : "";
    st.offset = 0;
    load();
  };
  $("#ed-prev", el).onclick = () => {
    st.offset = Math.max(0, st.offset - st.limit);
    load();
  };
  $("#ed-next", el).onclick = () => {
    st.offset += st.limit;
    load();
  };
  $("#ed-save", el).onclick = async () => {
    const ok = await startTask(
      "/api/dub/rerender",
      {
        job_id: jobId,
        edits: st.edits,
        voice: $("#ed-voice", el).value,
        delogo: $("#ed-delogo", el).value,
        burn_sub: $("#ed-sub", el).checked,
      },
      "Đang xuất lại — chỉ những câu và đoạn video bị sửa mới phải làm lại"
    );
    if (ok) close(true);
  };
  load();
}

function PageWorkspace() {
  let items = [];

  function rowHtml(v) {
    const d = v.dub;
    const j = v.job;
    const chips = [];
    if (d) chips.push(`<span class="badge green">${icon("check", 13)} Đã lồng tiếng · ${(d.segment_count || 0).toLocaleString("vi")} câu</span>`);
    if (j) chips.push(`<span class="badge ${j.status === "error" ? "red" : "amber"}">${j.status === "error" ? "Lỗi" : "Đang dở"} ở ${Math.round(j.pct)}%</span>`);
    if (!d && !j) chips.push(`<span class="badge gray">Chưa lồng tiếng</span>`);
    if (d?.untranslated) chips.push(`<span class="badge amber">${d.untranslated} câu chưa dịch</span>`);
    if (v.delogo !== "none" || (d && d.delogo && d.delogo !== "none")) chips.push(`<span class="badge blue">Đã xóa logo</span>`);

    const meta = [
      v.source === "bilibili" ? "Bilibili / YouTube" : "Douyin",
      v.resolution,
      fmtSize(v.size_mb),
      v.uploader,
    ].filter(Boolean);

    // Nút chính theo trạng thái: Tiếp tục > Xem bản Việt > Lồng tiếng
    const primary = j
      ? `<button class="btn btn-primary js-busy-disable" type="button" data-act="resume">${icon("play", 15)} Tiếp tục</button>`
      : d
        ? `<button class="btn btn-success" type="button" data-act="play-dub">${icon("play", 15)} Xem bản Việt</button>`
        : `<button class="btn btn-primary js-busy-disable" type="button" data-act="dub">${icon("mic", 15)} Lồng tiếng</button>`;
    const secondary = [
      j && d ? `<button class="btn btn-light" type="button" data-act="play-dub">${icon("play", 15)} Bản Việt</button>` : "",
      d ? `<button class="btn btn-light" type="button" data-act="edit-dub">${icon("edit", 15)} Sửa lời</button>` : "",
    ].join("");
    const menu = [
      d ? `<a href="${esc(dubFileUrl(d.mp4_file))}" download>${icon("download", 15)} Tải MP4 bản Việt</a>` : "",
      d ? `<a href="${esc(dubFileUrl(d.srt_file))}" download>${icon("cc", 15)} Tải phụ đề SRT</a>` : "",
      d || j ? `<button type="button" class="js-busy-disable" data-act="dub">${icon("mic", 15)} ${j ? "Tùy chọn / làm lại từ đầu" : "Lồng tiếng lại"}</button>` : "",
      `<button type="button" data-act="play-orig">${icon("film", 15)} Xem video gốc</button>`,
      v.source === "bilibili" ? `<button type="button" class="js-busy-disable" data-act="delogo">${icon("sparkles", 15)} Xóa logo video gốc</button>` : "",
      d?.cache_mb ? `<button type="button" data-act="clean">${icon("disk", 15)} Xóa cache (${fmtSize(d.cache_mb)})</button>` : "",
      `<hr /><button type="button" class="danger" data-act="delete">${icon("trash", 15)} Xóa video</button>`,
    ].join("");

    return `
      <article class="vrow" data-rel="${esc(v.rel_path)}">
        <button class="vrow-thumb" type="button" data-act="${d ? "play-dub" : "play-orig"}" aria-label="Phát video">
          <img src="/api/thumb?rel=${encodeURIComponent(v.rel_path)}&v=${v.mtime}" alt="" loading="lazy" onerror="this.remove()" />
          <span class="thumb-play">${icon("play", 20)}</span>
          ${v.duration_sec ? `<span class="thumb-dur">${fmtDur(v.duration_sec)}</span>` : ""}
        </button>
        <div class="vrow-main">
          <h3 class="vrow-title" title="${esc(v.title)}">${esc(v.title)}</h3>
          <div class="vrow-meta">${meta.map(esc).join(" · ")}</div>
          <div class="vrow-chips when-idle">${chips.join("")}</div>
          ${j?.error ? `<div class="vrow-err when-idle">${icon("alert", 14)} ${esc(j.error)}</div>` : ""}
          <div class="js-vid-prog" data-target="${esc(v.rel_path)}" data-job="${esc(d?.job_id || j?.job_id || "")}"></div>
        </div>
        <div class="vrow-actions">
          <button class="btn btn-danger when-running" type="button" data-stop>${icon("stop", 15)} Dừng</button>
          <span class="when-idle vrow-btns">${secondary}${primary}</span>
          <details class="menu">
            <summary class="icon-btn" title="Thao tác khác" aria-label="Thao tác khác">${icon("more")}</summary>
            <div class="menu-pop">${menu}</div>
          </details>
        </div>
      </article>`;
  }

  function draw() {
    items = buildWorkspaceItems();
    const count = { all: items.length, new: 0, partial: 0, dubbed: 0 };
    items.forEach((v) => count[v.status]++);
    const totalSec = items.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
    const totalMb = items.reduce((a, v) => a + Number(v.size_mb || 0), 0);

    $("#ws-metrics").innerHTML = [
      metric("film", "Video nguồn", items.length, totalSec ? `Tổng ${fmtHours(totalSec)}` : "", "blue"),
      metric("mic", "Đã lồng tiếng", count.dubbed, count.partial ? `${count.partial} video đang dở` : "", "green"),
      metric("disk", "Dung lượng video", fmtSize(totalMb), `Ổ còn trống ${state.sys.free_gb || 0} GB`, "violet"),
    ].join("");

    $$("#ws-filter button").forEach((b) => {
      b.classList.toggle("active", b.dataset.v === state.wf.filter);
      $(".cnt", b).textContent = count[b.dataset.v];
    });

    const q = state.wf.q.trim().toLowerCase();
    const shown = items.filter(
      (v) =>
        (state.wf.filter === "all" || v.status === state.wf.filter) &&
        (!q || v.title.toLowerCase().includes(q) || v.name.toLowerCase().includes(q))
    );
    $("#ws-list").innerHTML = !items.length
      ? emptyState("film", "Chưa có video nào", "Dán link Bilibili / YouTube để tải video đầu tiên, hoặc tải từ Kho Douyin.",
          `<button class="btn btn-primary" type="button" data-add>${icon("plus", 16)} Thêm video</button>`)
      : !shown.length
        ? emptyState("search", "Không có video phù hợp", "Thử đổi bộ lọc hoặc từ khóa tìm kiếm.")
        : shown.map(rowHtml).join("");
    renderTaskWidgets();
  }

  const find = (el) => items.find((v) => v.rel_path === el.closest("[data-rel]")?.dataset.rel);

  return {
    render: () => `
      <div class="metrics" id="ws-metrics"></div>
      <div class="toolbar ws-toolbar">
        <div class="seg" id="ws-filter" role="tablist">
          <button type="button" data-v="all">Tất cả <span class="cnt">0</span></button>
          <button type="button" data-v="new">Chưa làm <span class="cnt">0</span></button>
          <button type="button" data-v="partial">Đang dở <span class="cnt">0</span></button>
          <button type="button" data-v="dubbed">Đã lồng tiếng <span class="cnt">0</span></button>
        </div>
        <input id="ws-q" class="input" type="search" placeholder="Tìm video theo tên..." aria-label="Tìm video" />
        <button class="btn btn-primary" type="button" data-add>${icon("plus", 16)} Thêm video</button>
      </div>
      <div class="js-task-inline" data-type="bilibili_download" hidden></div>
      <div class="vlist" id="ws-list"></div>`,

    mount() {
      $("#ws-q").value = state.wf.q;
      $("#ws-q").oninput = (e) => {
        state.wf.q = e.target.value;
        draw();
      };
      $("#ws-filter").onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        state.wf.filter = b.dataset.v;
        draw();
      };
      $("#content").onclick = async (e) => {
        if (e.target.closest("[data-add]")) return openAddVideoModal();
        const b = e.target.closest("[data-act]");
        const v = b && find(b);
        if (!v) return;
        b.closest("details")?.removeAttribute("open");
        const act = b.dataset.act;
        if (act === "dub") openDubConfigModal(v);
        if (act === "resume")
          startTask("/api/dub/start", { rel_path: v.rel_path, ...v.job.params }, "Đang chạy tiếp từ chỗ đang dở");
        if (act === "play-orig") openPlayer(v.video_src, v.title);
        if (act === "play-dub") openPlayer(dubFileUrl(v.dub.mp4_file), `Bản Việt · ${v.title}`);
        if (act === "edit-dub") openDubEditorModal(v.dub.job_id);
        if (act === "delogo") openDelogoModal(v);
        if (act === "delete") openDeleteVideoModal(v);
        if (act === "clean") {
          if (!confirm("Xóa cache của bản lồng tiếng này?\n\nVideo đã xuất vẫn giữ nguyên. Lần xuất lại sau sẽ phải tạo lại giọng đọc và mã hóa lại toàn bộ.")) return;
          const d = await postJSON("/api/dub/clean", { job_id: v.dub.job_id });
          toast(d.ok ? "Đã xóa cache" : d.error || "Không xóa được cache", d.ok ? "success" : "error");
          loadAll();
        }
      };
    },
    update: draw,
  };
}

/* =========================================================
   TRANG: KHO DOUYIN (3 tab: Danh sách · Tải theo tập · Quét kênh)
   ========================================================= */
function DouyinList() {
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

  const gridHtml = (list) => `<div class="vgrid">${list.map((v) => `
    <article class="vcard" data-id="${esc(v.aweme_id)}" tabindex="0">
      <div class="vthumb">
        ${thumbImg(v.cover_url, v.title)}
        <div class="tl">${v.episode_label ? `<span class="ov">Tập ${esc(v.episode_label)}</span>` : ""}</div>
        <div class="tr">${v._season === "p2" ? `<span class="ov purple">P2</span>` : v._season === "p1" ? `<span class="ov amber">P1</span>` : ""}</div>
        <div class="bl">${v.local_file ? `<span class="ov green">Đã tải</span>` : ""}</div>
        <div class="br">${v.duration_sec ? `<span class="ov">${fmtDur(v.duration_sec)}</span>` : ""}</div>
      </div>
      <div class="vbody">
        <div class="vtitle" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="vmeta"><span>${dateOnly(v.publish_date)} · ♥ ${esc(v.likes_raw || v.likes || 0)}</span>${statusBadge(v)}</div>
      </div>
    </article>`).join("")}</div>`;

  const tableHtml = (list, offset) => `<section class="card"><div class="table-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Ảnh</th><th>Phần / Tập</th><th>Tiêu đề</th><th>Ngày đăng</th><th>Thời lượng</th><th>Thích</th><th>Trạng thái</th></tr></thead>
    <tbody>${list.map((v, i) => `
      <tr class="clickable" data-id="${esc(v.aweme_id)}">
        <td class="muted">${offset + i + 1}</td>
        <td>${v.cover_url ? `<img class="thumb" src="${esc(v.cover_url)}" referrerpolicy="no-referrer" loading="lazy" alt="" />` : ""}</td>
        <td class="nowrap">${seasonBadge(v)} ${v.episode_label ? `<b>Tập ${esc(v.episode_label)}</b>` : ""}</td>
        <td class="title-cell">${esc(v.title)}</td>
        <td class="nowrap">${dateOnly(v.publish_date)}</td>
        <td>${fmtDur(v.duration_sec) || "—"}</td>
        <td class="nowrap">${esc(v.likes_raw || v.likes || 0)}</td>
        <td>${statusBadge(v)}</td>
      </tr>`).join("")}
    </tbody></table></div></section>`;

  function pagerHtml(page, pages) {
    if (pages <= 1) return "";
    const nums = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    let html = `<button type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ Trước</button>`;
    let prev = 0;
    for (const n of nums) {
      if (n - prev > 1) html += `<span class="gap">…</span>`;
      html += `<button type="button" data-page="${n}" class="${n === page ? "active" : ""}">${n}</button>`;
      prev = n;
    }
    return html + `<button type="button" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Sau ›</button>`;
  }

  function draw() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.vf.page = Math.min(state.vf.page, pages);
    const page = state.vf.page;
    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);

    $("#vf-meta").innerHTML = `<span>Hiển thị <b>${list.length ? start + 1 : 0}–${start + slice.length}</b> trong <b>${list.length}</b> video</span>`;
    $("#vf-list").innerHTML = !state.videos.length
      ? emptyState("scan", "Chưa có video nào", "Quét kênh Douyin để lấy danh sách video.", `<a class="btn btn-primary" href="${projLink("douyin/scan")}">Đi tới Quét kênh</a>`)
      : !list.length
        ? emptyState("search", "Không tìm thấy video phù hợp", "Thử đổi bộ lọc hoặc từ khóa tìm kiếm.")
        : state.vf.view === "grid" ? gridHtml(slice) : tableHtml(slice, start);
    $("#vf-pager").innerHTML = pagerHtml(page, pages);

    const c = { all: state.videos.length, p1: 0, p2: 0, other: 0 };
    state.videos.forEach((v) => c[v._season]++);
    $$("#vf-season button").forEach((b) => ($(".cnt", b).textContent = c[b.dataset.v]));
  }

  const setSeg = (id, val) => $$(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset.v === val));

  return {
    render: () => `
      <div class="toolbar">
        <div class="seg" id="vf-season">
          <button type="button" data-v="all">Tất cả <span class="cnt">0</span></button>
          <button type="button" data-v="p2">Phần 2 <span class="cnt">0</span></button>
          <button type="button" data-v="p1">Phần 1 <span class="cnt">0</span></button>
          <button type="button" data-v="other">Video phụ <span class="cnt">0</span></button>
        </div>
        <input id="vf-q" class="input" type="search" placeholder="Tìm theo tên, số tập (25), ngày (2026-03)..." aria-label="Tìm video Douyin" />
        <select id="vf-sort" class="select" aria-label="Sắp xếp">
          <option value="time_desc">Mới đăng trước</option>
          <option value="time_asc">Cũ trước (đúng mạch truyện)</option>
          <option value="ep_asc">Số tập tăng dần</option>
          <option value="ep_desc">Số tập giảm dần</option>
          <option value="likes_desc">Nhiều lượt thích</option>
        </select>
        <select id="vf-status" class="select" aria-label="Trạng thái">
          <option value="all">Mọi trạng thái</option>
          <option value="pending">Chưa reup</option>
          <option value="downloaded">Đã tải</option>
          <option value="reupped">Đã reup</option>
        </select>
        <div class="seg" id="vf-view">
          <button type="button" data-v="grid" title="Dạng thẻ" aria-label="Dạng thẻ">${icon("grid", 16)}</button>
          <button type="button" data-v="table" title="Dạng bảng" aria-label="Dạng bảng">${icon("list", 16)}</button>
        </div>
      </div>
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

      const onSeg = (id, key) => ($("#" + id).onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        f[key] = b.dataset.v;
        f.page = 1;
        setSeg(id, f[key]);
        draw();
      });
      onSeg("vf-season", "season");
      onSeg("vf-view", "view");
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
      $("#vf-list").onkeydown = (e) => {
        if (e.key === "Enter" && e.target.matches("[data-id]")) openVideoDetail(e.target.dataset.id);
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

function openVideoDetail(awemeId) {
  const v = state.videos.find((x) => String(x.aweme_id) === String(awemeId));
  if (!v) return;
  const media = v.local_file
    ? `<video src="${esc(douyinFileUrl(v.local_file))}" controls></video>`
    : thumbImg(v.cover_url, v.title) || `<span class="muted">Không có ảnh bìa</span>`;

  const html = `
    <div class="detail">
      <div>
        <div class="detail-media">${media}</div>
        <div class="actions">
          ${v.local_file
            ? `<a class="btn btn-success" href="${esc(douyinFileUrl(v.local_file))}" download>${icon("download", 16)} Lưu file MP4</a>`
            : v.download_url
              ? `<button class="btn btn-primary js-busy-disable" type="button" id="dt-download">${icon("download", 16)} Tải về máy</button>`
              : ""}
          ${v.video_url ? `<a class="btn btn-light" href="${esc(v.video_url)}" target="_blank" rel="noopener">${icon("external", 15)} Mở trên Douyin</a>` : ""}
          ${v.video_url ? `<button class="btn btn-quiet" type="button" id="dt-copy">${icon("copy", 15)} Sao chép link</button>` : ""}
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
        <div class="field">
          <label for="dt-status">Trạng thái reup</label>
          <select id="dt-status" class="select">${options(Object.entries(STATUS_LABEL), v.reup_status === "reupped" || v.reup_status === "downloaded" ? v.reup_status : "pending")}</select>
        </div>
      </div>
    </div>`;

  const { el } = openModal(epText(v), html, { size: "wide" });
  const sel = $("#dt-status", el);
  sel.onchange = async () => {
    const d = await postJSON("/api/status", { key: videoKey(v), status: sel.value });
    if (d.ok) {
      toast(`Đã chuyển sang "${STATUS_LABEL[sel.value]}"`, "success");
      loadAll();
    } else toast(d.error || "Không lưu được trạng thái", "error");
  };
  const dlBtn = $("#dt-download", el);
  if (dlBtn) dlBtn.onclick = () => startTask("/api/download", { ids: v.aweme_id }, "Đang tải video");
  const cpBtn = $("#dt-copy", el);
  if (cpBtn) cpBtn.onclick = () => copyText(v.video_url);
}

function DouyinBatch() {
  function selection() {
    const season = $("#dl-season").value;
    const from = Number($("#dl-from").value || 0);
    const to = Number($("#dl-to").value || 0);
    const skip = $("#dl-skip").checked;
    return state.videos
      .filter((v) => (season === "all" ? v._season !== "other" : v._season === season))
      .filter((v) => v.episode_num != null && v.episode_num >= from && v.episode_num <= to)
      .filter((v) => v.download_url && !(skip && v.local_file))
      .sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
  }

  function draw() {
    const sel = selection();
    const dur = sel.reduce((a, v) => a + Number(v.duration_sec || 0), 0);
    $("#dl-preview").innerHTML = sel.length
      ? callout("info", "download", `Sẽ tải <b>${sel.length} video</b> (tổng khoảng <b>${fmtHours(dur)}</b>), từ “${esc(sel[0].title.slice(0, 36))}…” đến “${esc(sel[sel.length - 1].title.slice(0, 36))}…”`)
      : callout("warn", "info", "Không có video nào khớp. Kiểm tra lại phần và khoảng tập, hoặc quét kênh để làm mới link tải.");
    $("#dl-start").disabled = !sel.length || state.task.running;

    const done = state.videos.filter((v) => v.local_file).sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
    $("#dl-done-count").textContent = done.length;
    $("#dl-done").innerHTML = done.length
      ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Phần / Tập</th><th>Tiêu đề</th><th>Thời lượng</th><th></th></tr></thead>
          <tbody>${done.map((v) => `
            <tr>
              <td class="nowrap">${seasonBadge(v)} ${v.episode_label ? `<b>Tập ${esc(v.episode_label)}</b>` : ""}</td>
              <td class="title-cell">${esc(v.title)}</td>
              <td>${fmtDur(v.duration_sec) || "—"}</td>
              <td class="nowrap">
                <button class="btn btn-light btn-sm" type="button" data-play="${esc(v.local_file)}" data-title="${esc(v.title)}">${icon("play", 14)} Xem</button>
                <a class="btn btn-quiet btn-sm" href="${esc(douyinFileUrl(v.local_file))}" download>${icon("download", 14)} Lưu</a>
              </td>
            </tr>`).join("")}
          </tbody></table></div>`
      : `<p class="muted pad">Chưa tải video nào. Video tải xong sẽ tự xuất hiện ở trang <a href="${projLink("videos")}">Video & Lồng tiếng</a>.</p>`;
  }

  return {
    render: () => `
      <section class="card">
        <header class="card-head"><h3>Tải hàng loạt theo tập</h3><span class="hint">MP4 gốc từ Douyin, lưu vào <code>downloads/</code></span></header>
        <div class="card-body">
          <div class="form-grid cols-3">
            <div class="field">
              <label for="dl-season">Phần</label>
              <select id="dl-season" class="select">
                <option value="p2">Phần 2 — Tập 1 → 275 (liền mạch)</option>
                <option value="p1">Phần 1 — Tập 1 → 467 (thiếu 138–314)</option>
                <option value="all">Cả 2 phần</option>
              </select>
            </div>
            <div class="field"><label for="dl-from">Từ tập</label><input id="dl-from" class="input" type="number" min="1" value="1" /></div>
            <div class="field"><label for="dl-to">Đến tập</label><input id="dl-to" class="input" type="number" min="1" value="10" /></div>
          </div>
          <label class="check"><input id="dl-skip" type="checkbox" checked /> Bỏ qua các tập đã tải</label>
          <div id="dl-preview"></div>
        </div>
        <div class="card-foot">
          <button class="btn btn-primary" type="button" id="dl-start">${icon("download", 16)} Bắt đầu tải</button>
          <span class="muted">Lỗi <code>403</code>? Link tải đã hết hạn — vào tab Quét kênh, bấm Quét nối tiếp rồi tải lại.</span>
        </div>
      </section>
      <section class="card">
        <header class="card-head"><h3>Đã tải về máy <span class="badge green" id="dl-done-count">0</span></h3></header>
        <div id="dl-done"></div>
      </section>`,

    mount() {
      ["dl-season", "dl-from", "dl-to", "dl-skip"].forEach((id) => $("#" + id).addEventListener("input", draw));
      $("#dl-start").onclick = () => {
        const sel = selection();
        if (sel.length) startTask("/api/download", { ids: sel.map((v) => v.aweme_id).join(",") }, `Bắt đầu tải ${sel.length} video`);
      };
      $("#dl-done").onclick = (e) => {
        const b = e.target.closest("[data-play]");
        if (b) openPlayer(douyinFileUrl(b.dataset.play), b.dataset.title);
      };
    },
    update: draw,
  };
}

function DouyinScan() {
  return {
    render: () => `
      <div class="cols cols-main-side">
        <div>
          <section class="card">
            <header class="card-head"><h3><span class="step-badge">1</span> Đăng nhập Douyin</h3><span class="hint">Chỉ cần làm một lần</span></header>
            <div class="card-body">
              <p class="lead">Douyin Web cần đăng nhập mới xem được danh sách video. Mở Chrome, đăng nhập bằng mã QR, rồi <b>đóng cửa sổ Chrome</b> để lưu phiên vào <code>chrome_profile/</code>.</p>
              <button class="btn btn-light js-busy-disable" type="button" id="btn-login">${icon("key", 16)} Mở Chrome để đăng nhập</button>
            </div>
          </section>
          <section class="card">
            <header class="card-head"><h3><span class="step-badge">2</span> Quét danh sách video</h3></header>
            <div class="card-body">
              <div class="field">
                <label for="scan-url">Link kênh Douyin</label>
                <input id="scan-url" class="input" type="url" value="${esc(DEFAULT_CHANNEL_URL)}" />
              </div>
              <div class="actions">
                <button class="btn btn-primary js-busy-disable" type="button" id="btn-scan-resume">${icon("scan", 16)} Quét nối tiếp</button>
                <button class="btn btn-light js-busy-disable" type="button" id="btn-scan-new">${icon("refresh", 16)} Quét lại từ đầu</button>
              </div>
              ${callout("info", "info", "<b>Quét nối tiếp</b> giữ trạng thái reup đã đánh dấu, chỉ thêm video mới và làm mới link tải. Chrome sẽ tự mở và cuộn trang — đừng đóng nó cho tới khi quét xong.")}
            </div>
          </section>
        </div>
        <aside>
          <section class="card">
            <header class="card-head"><h3>Kênh</h3></header>
            <div class="card-body" id="scan-channel"></div>
          </section>
        </aside>
      </div>`,

    mount() {
      const url = () => $("#scan-url").value.trim();
      $("#btn-login").onclick = () => startTask("/api/login", { url: url() }, "Đang mở Chrome để đăng nhập");
      $("#btn-scan-resume").onclick = () => startTask("/api/scan", { url: url(), resume: true }, "Bắt đầu quét nối tiếp");
      $("#btn-scan-new").onclick = () => {
        if (!confirm("Quét lại từ đầu sẽ ghi đè dữ liệu cũ, kể cả trạng thái reup đã đánh dấu. Tiếp tục?")) return;
        startTask("/api/scan", { url: url(), resume: false }, "Bắt đầu quét lại từ đầu");
      };
    },

    update() {
      const m = state.meta;
      const total = Number(m.total_works || 0);
      const got = state.videos.length;
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
      const c = { p1: 0, p2: 0, other: 0 };
      state.videos.forEach((v) => c[v._season]++);
      const link = m.channel_url || m.share_url;
      $("#scan-channel").innerHTML = `
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="prog-meta"><span>Đã quét <b>${got}</b> / ${total || "?"} video</span><span>${pct}%</span></div>
        <dl class="kv">
          <dt>Tên kênh</dt><dd>${esc(m.channel_name || "—")}</dd>
          <dt>Douyin ID</dt><dd>${esc(m.douyin_id || "—")}</dd>
          <dt>Cập nhật</dt><dd>${esc(state.updatedAt || "chưa quét")}</dd>
          <dt>Phần 2</dt><dd>${c.p2} video</dd>
          <dt>Phần 1</dt><dd>${c.p1} video</dd>
          <dt>Video phụ</dt><dd>${c.other} video</dd>
          <dt>Link</dt><dd>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Mở trên Douyin ${icon("external", 13)}</a>` : "—"}</dd>
        </dl>`;
    },
  };
}

function PageDouyin(tab) {
  const tabs = [
    ["list", "Danh sách video", DouyinList],
    ["batch", "Tải theo tập", DouyinBatch],
    ["scan", "Quét kênh", DouyinScan],
  ];
  const inner = (tabs.find((t) => t[0] === tab) || tabs[0])[2]();
  return {
    render: () => `
      <nav class="page-tabs" aria-label="Kho Douyin">
        ${tabs.map(([k, label]) => `<a href="${projLink(`douyin/${k}`)}" class="${k === tab ? "active" : ""}">${label}</a>`).join("")}
      </nav>
      <div class="js-task-inline" data-type="scan_web" hidden></div>
      <div class="js-task-inline" data-type="download" hidden></div>
      ${inner.render()}`,
    mount: () => inner.mount?.(),
    update: () => inner.update?.(),
  };
}

/* =========================================================
   TRANG: NHẬT KÝ · HƯỚNG DẪN
   ========================================================= */
function PageLogs() {
  return {
    render: () => `
      <div class="js-task" data-variant="page"></div>
      <section class="card">
        <header class="card-head">
          <h3>Nhật ký chi tiết</h3>
          <button class="btn btn-light btn-sm" type="button" id="log-copy">${icon("copy", 14)} Sao chép</button>
        </header>
        <pre class="console js-log" tabindex="0"></pre>
        <div class="card-foot muted">Hiện 500 dòng gần nhất. Toàn bộ nhật ký của lần chạy gần nhất nằm ở <code>data/last_task.log</code>.</div>
      </section>`,
    mount() {
      $("#log-copy").onclick = () => copyText((state.task.logs || []).join("\n"));
    },
  };
}

function PageHelp() {
  const step = (n, title, body) => `<li><span class="step-badge">${n}</span><div><b>${title}</b><p>${body}</p></div></li>`;
  return {
    render: () => `
      <div class="cols cols-2">
        <section class="card">
          <header class="card-head"><h3>Quy trình 4 bước</h3></header>
          <div class="card-body">
            <ol class="steps">
              ${step(1, "Tạo dự án", "Mỗi bộ truyện / phim là một dự án. Nhập bối cảnh và nhân vật để AI dịch đúng xưng hô.")}
              ${step(2, "Thêm video", "Trong dự án, bấm <b>Thêm video</b> và dán link Bilibili / YouTube; hoặc tải từ <b>Kho Douyin</b>.")}
              ${step(3, "Lồng tiếng", "Bấm <b>Lồng tiếng</b> ở video. Máy tự nhận diện lời thoại → dịch → tạo giọng Việt → xuất video.")}
              ${step(4, "Sửa lời & xuất lại", "Bấm <b>Sửa lời</b>, chỉnh câu chưa ưng rồi xuất lại — chỉ câu và đoạn bị sửa mới phải làm lại.")}
            </ol>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>Video rất dài (9 – 90 tiếng)</h3></header>
          <div class="card-body prose">
            <ul>
              <li><b>Chạy tiếp được.</b> Video được xử lý theo khối 10 phút và lưu tiến độ liên tục. Dừng, tắt máy, mất mạng — bấm <b>Tiếp tục</b> là chạy từ chỗ đang dở.</li>
              <li><b>Không tốn RAM.</b> Mỗi lúc chỉ một khối nằm trong bộ nhớ, video 90 tiếng dùng RAM như video 10 phút.</li>
              <li><b>Chọn “Không xóa lúc tải”</b> khi thêm video, rồi bật <b>Xóa logo khi xuất</b> ở bước lồng tiếng: video chỉ bị mã hóa một lần.</li>
              <li><b>Ổ cứng:</b> cần trống khoảng 2,2 lần dung lượng video nếu in phụ đề / xóa logo; khoảng 1,2 lần nếu giữ nguyên hình.</li>
              <li><b>Thời gian:</b> chế độ nhận diện <b>Nhanh</b> mất khoảng 0,6 lần thời lượng video khi có in phụ đề. Cứ để máy chạy qua đêm.</li>
              <li><b>Cache:</b> giọng đọc và các đoạn video đã mã hóa được giữ lại để xuất lại nhanh. Lấy lại ổ cứng bằng <b>⋯ → Xóa cache</b>.</li>
            </ul>
          </div>
        </section>
      </div>

      <div class="cols cols-2">
        <section class="card">
          <header class="card-head"><h3>Câu hỏi thường gặp</h3></header>
          <div class="card-body">
            <details class="faq"><summary>Báo “Đang có tiến trình khác chạy”?</summary>
              <p>Mỗi lúc chỉ chạy một tiến trình. Đợi xong hoặc bấm <b>Dừng</b> ở góc dưới bên trái — tiến độ lồng tiếng vẫn được lưu.</p></details>
            <details class="faq"><summary>Một số câu bị “chưa dịch”?</summary>
              <p>Antigravity lỗi tạm thời ở vài lô. Mở <b>Sửa lời</b>, tick <b>Chỉ câu chưa dịch</b> để điền tay, hoặc chọn <b>Lồng tiếng lại</b>.</p></details>
            <details class="faq"><summary>Video Bilibili vẫn còn logo?</summary>
              <p>Logo nằm ở góc khác. Chọn <b>Cả 2 góc trên</b> khi lồng tiếng hoặc trong <b>⋯ → Xóa logo video gốc</b>.</p></details>
            <details class="faq"><summary>Quét kênh Douyin dừng sớm hoặc tải bị lỗi 403?</summary>
              <p>Do mạng chậm, Douyin đòi xác minh, hoặc link tải hết hạn. Vào <b>Kho Douyin → Quét kênh</b>, bấm <b>Quét nối tiếp</b> rồi tải lại.</p></details>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h3>Vị trí các file</h3></header>
          <div class="table-wrap"><table class="tbl">
            <tbody>
              <tr><td><code>downloads/bilibili/</code></td><td>Video tải từ Bilibili / YouTube</td></tr>
              <tr><td><code>downloads/</code></td><td>Video tải từ Douyin</td></tr>
              <tr><td><code>downloads/dubbed/</code></td><td>Bản lồng tiếng Việt (<code>.mp4</code>) và phụ đề (<code>.srt</code>)</td></tr>
              <tr><td><code>data/projects/</code></td><td>Ngữ cảnh AI của từng dự án</td></tr>
              <tr><td><code>data/dub_work/</code></td><td>Tiến độ đang dở và cache giọng đọc / video</td></tr>
              <tr><td><code>chrome_profile/</code></td><td>Phiên đăng nhập Douyin</td></tr>
            </tbody>
          </table></div>
        </section>
      </div>`,
  };
}

/* =========================================================
   ROUTER
   ========================================================= */
const GLOBAL_ROUTES = {
  "/projects": { title: "Dự án", sub: "Mỗi bộ truyện / phim một dự án — AI nhớ nhân vật, xưng hô và mạch truyện", page: PageProjects },
  "/logs": { title: "Nhật ký", sub: "Tiến trình đang chạy và kết quả lần chạy gần nhất", page: PageLogs },
  "/help": { title: "Hướng dẫn", sub: "Quy trình làm việc và mẹo xử lý video rất dài", page: PageHelp },
};

const PROJECT_ROUTES = {
  videos: { title: "Video & Lồng tiếng", sub: "Tải video, dịch theo ngữ cảnh dự án và lồng tiếng Việt", page: PageWorkspace },
  "douyin/list": { title: "Kho Douyin", sub: "Xem, lọc và đánh dấu trạng thái từng tập", page: () => PageDouyin("list") },
  "douyin/batch": { title: "Kho Douyin", sub: "Tải file MP4 gốc theo phần và khoảng tập", page: () => PageDouyin("batch") },
  "douyin/scan": { title: "Kho Douyin", sub: "Lấy danh sách video và link tải từ Douyin Web", page: () => PageDouyin("scan") },
  logs: GLOBAL_ROUTES["/logs"],
};
// Đường dẫn của giao diện cũ vẫn mở đúng trang mới
const ROUTE_ALIASES = {
  dubbing: "videos", "bilibili-new": "videos", "bilibili-library": "videos",
  douyin: "douyin/list", "douyin-videos": "douyin/list", "douyin-downloads": "douyin/batch", "douyin-scan": "douyin/scan",
};

let currentPage = null;

function parseRoute() {
  const path = location.hash.replace(/^#/, "") || "/projects";
  const m = path.match(/^\/project\/([^/]+)(?:\/(.*))?$/);
  if (!m) return { path, pid: "", sub: "" };
  const sub = m[2] || "videos";
  return { path, pid: decodeURIComponent(m[1]), sub: ROUTE_ALIASES[sub] || sub };
}

function router() {
  const { path, pid, sub } = parseRoute();
  let route;
  let actions;

  if (pid) {
    const proj = state.projects.find((p) => p.id === pid);
    if ((state.loaded && !proj) || !PROJECT_ROUTES[sub]) {
      location.hash = state.loaded && !proj ? "#/projects" : `#/project/${encodeURIComponent(pid)}/videos`;
      return;
    }
    state.activeProjectId = pid;
    route = PROJECT_ROUTES[sub];
    document.title = `${route.title} · ${proj?.name || "OpenReup Studio"}`;
    actions = `<button class="btn btn-light" type="button" data-drawer="${esc(pid)}">${icon("brain", 16)}<span class="lbl">Ngữ cảnh AI</span></button>`;
  } else {
    route = GLOBAL_ROUTES[path];
    if (!route) {
      location.hash = "#/projects";
      return;
    }
    document.title = `${route.title} · OpenReup Studio`;
    actions = path === "/projects" ? `<button class="btn btn-primary" type="button" data-new-project>${icon("plus", 16)}<span class="lbl">Tạo dự án</span></button>` : "";
  }

  $("#page-title").textContent = route.title;
  $("#page-sub").textContent = route.sub;
  $("#topbar-actions").innerHTML = `${actions}<button class="icon-btn" type="button" data-refresh title="Làm mới dữ liệu" aria-label="Làm mới dữ liệu">${icon("refresh")}</button>`;

  renderSidebar();
  const content = $("#content");
  content.onclick = null;
  currentPage = route.page();
  content.innerHTML = currentPage.render();
  currentPage.mount?.();
  if (state.loaded) currentPage.update?.();
  renderTaskWidgets();
  document.body.classList.remove("sb-open");
  window.scrollTo(0, 0);
}

/* ------------------------- Khởi động ------------------------- */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  $("#theme-toggle").innerHTML = `${icon(theme === "dark" ? "sun" : "moon", 16)}<span>${theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}</span>`;
}

document.addEventListener("click", (e) => {
  // Các nút dùng chung toàn trang
  if (e.target.closest("[data-stop]")) return stopTask();
  if (e.target.closest("[data-refresh]")) return loadAll(true);
  if (e.target.closest("[data-new-project]")) return openNewProjectModal();
  const drawer = e.target.closest("[data-drawer]");
  if (drawer) return openProjectDrawer(drawer.dataset.drawer);
  // Đóng menu "⋯" khi bấm ra ngoài
  $$("details.menu[open]").forEach((d) => !d.contains(e.target) && d.removeAttribute("open"));
});

$("#menu-btn").innerHTML = icon("menu");
$("#menu-btn").onclick = () => document.body.classList.toggle("sb-open");
$("#sb-backdrop").onclick = () => document.body.classList.remove("sb-open");
$("#sb-help").innerHTML = `${icon("help", 16)}<span>Hướng dẫn</span>`;
$("#theme-toggle").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
setTheme(document.documentElement.dataset.theme);

window.addEventListener("hashchange", router);
router();
loadAll();
pollTask();
setInterval(pollTask, 2500);
