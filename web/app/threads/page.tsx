"use client";
/**
 * Tab Threads (/threads/): tái sử dụng trực tiếp layout `.studio` của OpenReup.
 * Ẩn/hiện đúng bảng đặc tả Phase 4 giữa 2 chế độ:
 * - Video (ReupThreads): URL/video cục bộ, giọng đọc, âm lượng gốc 0–200% (4 preset + limiter >100%), agy model, delogo, subcover, burn_sub.
 * - Chữ / Ảnh (VideoThreads): URL bài viết, giọng đọc, giao diện thẻ (dark/light), FPS (60/30), số bình luận (1–5), video nền gameplay.
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { Callout, EmptyState, Options } from "@/components/ui";
import { AgyModelField } from "@/components/video/AgyModelField";
import { OriginalAudioSlider } from "@/components/video/studio/OriginalAudioSlider";
import { fileUrl, getJSON } from "@/lib/api";
import { useStudio } from "@/lib/studio";
import { voiceOptions } from "@/lib/voices";

type ThreadsMode = "reup_threads" | "video_threads";

type ThreadsJob = {
  id: string;
  mode: string;
  url: string;
  local_video_path: string;
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  output_rel_path: string;
  created_at: string;
  updated_at: string;
};

export default function ThreadsPage() {
  const toast = useToast();
  const { voices, task, startTask } = useStudio();
  const allVoices = [...voices.clones, ...voices.presets];

  const [mode, setMode] = useState<ThreadsMode>("reup_threads");
  const [url, setUrl] = useState("");
  const [localVideoPath, setLocalVideoPath] = useState("");
  const [voice, setVoice] = useState("");
  const [originalAudioVolumePct, setOriginalAudioVolumePct] = useState(20);
  const [delogo, setDelogo] = useState("none");
  const [subcover, setSubcover] = useState("none");
  const [burnSub, setBurnSub] = useState(true);
  const [agyModel, setAgyModel] = useState("");
  const [maxDurationSec, setMaxDurationSec] = useState(180);

  // Chữ/Ảnh (VideoThreads)
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [fps, setFps] = useState<60 | 30>(60);
  const [maxComments, setMaxComments] = useState(5);
  const [bgVideoPath, setBgVideoPath] = useState("");

  const [jobs, setJobs] = useState<ThreadsJob[]>([]);
  const [selectedId, setSelectedId] = useState("");

  const loadJobs = useCallback(async () => {
    const res = await getJSON<{ ok: boolean; jobs?: ThreadsJob[] }>("/api/threads/jobs?limit=30");
    if (res.jobs) {
      setJobs(res.jobs);
      setSelectedId((cur) => cur || res.jobs?.[0]?.id || "");
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs, task?.ended_at]);

  const activeJob = jobs.find((j) => j.id === selectedId) || jobs[0] || null;
  const isVideoMode = mode === "reup_threads";

  async function handleRun() {
    if (isVideoMode) {
      if (!url.trim() && !localVideoPath.trim()) {
        return toast("Nhập link bài viết Threads có video hoặc đường dẫn video cục bộ.", "error");
      }
      const ok = await startTask(
        "/api/threads/reup",
        {
          url: url.trim() || undefined,
          local_video_path: localVideoPath.trim() || undefined,
          voice: voice || undefined,
          original_audio_volume_pct: originalAudioVolumePct,
          delogo: delogo.trim() || "none",
          subcover: subcover.trim() || "none",
          burn_sub: burnSub,
          agy_model: agyModel || undefined,
          max_duration_sec: maxDurationSec,
        },
        "Đã đưa tác vụ ReupThreads vào hàng đợi GPU",
      );
      if (ok) setTimeout(loadJobs, 300);
    } else {
      if (!url.trim()) {
        return toast("Nhập link bài viết Threads (chữ/ảnh).", "error");
      }
      const ok = await startTask(
        "/api/threads/video",
        {
          url: url.trim(),
          voice: voice || undefined,
          theme,
          fps,
          max_comments: maxComments,
          background_video_path: bgVideoPath.trim() || undefined,
        },
        "Đã đưa tác vụ VideoThreads vào hàng đợi GPU",
      );
      if (ok) setTimeout(loadJobs, 300);
    }
  }

  return (
    <>
      <Topbar
        title="Threads Studio"
        meta={isVideoMode ? "Chế độ Video (ReupThreads)" : "Chế độ Chữ / Ảnh (VideoThreads)"}
        actions={
          <button className="btn btn-light btn-sm" type="button" onClick={loadJobs}>
            <Icon name="refresh" size={14} /> Làm mới
          </button>
        }
      />

      <main className="studio">
        {/* Sân khấu xem trước kết quả video Threads */}
        <section className="studio-stage" aria-label="Xem trước video Threads" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
          {activeJob?.output_rel_path ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%", height: "100%", justifyContent: "center" }}>
              <video
                key={activeJob.output_rel_path}
                src={fileUrl(activeJob.output_rel_path)}
                controls
                style={{ maxHeight: "100%", maxWidth: "100%", borderRadius: 12, background: "#000" }}
              />
              <div className="muted" style={{ fontSize: 12 }}>
                {activeJob.id} · {activeJob.output_rel_path}
              </div>
            </div>
          ) : (
            <EmptyState
              icon="sparkles"
              title={isVideoMode ? "Reup Video từ Threads" : "Tạo Video 9:16 từ bài Chữ/Ảnh Threads"}
              desc={
                isVideoMode
                  ? "Dán link bài viết Threads có video (hoặc đường dẫn video cục bộ), chỉnh âm lượng gốc 0–200% và bấm Bắt đầu."
                  : "Dán link bài viết Threads chữ/ảnh để tự động dựng video dọc 1080×1920 @ 60fps bằng Remotion."
              }
            />
          )}
        </section>

        {/* Panel cấu hình bên phải */}
        <aside className="studio-panel" aria-label="Cấu hình Threads">
          <div className="seg studio-tabs" role="tablist" aria-label="Chế độ Threads">
            <button
              type="button"
              role="tab"
              aria-selected={isVideoMode}
              className={isVideoMode ? "active" : ""}
              onClick={() => setMode("reup_threads")}
            >
              <Icon name="film" size={15} /> Video (Reup)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isVideoMode}
              className={!isVideoMode ? "active" : ""}
              onClick={() => setMode("video_threads")}
            >
              <Icon name="image" size={15} /> Chữ / Ảnh
            </button>
          </div>

          <div className="panel-pane">
            <div className="field">
              <label htmlFor="th-url">Link bài viết Threads</label>
              <input
                id="th-url"
                className="input"
                type="url"
                placeholder="https://www.threads.net/@user/post/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            {isVideoMode && (
              <div className="field">
                <label htmlFor="th-local">Hoặc đường dẫn video cục bộ (tùy chọn)</label>
                <input
                  id="th-local"
                  className="input"
                  type="text"
                  placeholder="downloads/threads/sample.mp4"
                  value={localVideoPath}
                  onChange={(e) => setLocalVideoPath(e.target.value)}
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="th-voice">Giọng đọc</label>
              <select
                id="th-voice"
                className="select"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                <option value="">Mặc định (VieNeu-TTS)</option>
                <Options list={voiceOptions(allVoices, undefined, voice)} />
              </select>
            </div>

            {/* Mục riêng cho chế độ Video (ReupThreads) — Ẩn ở chế độ Chữ/Ảnh */}
            {isVideoMode ? (
              <>
                <OriginalAudioSlider
                  id="th-orig-vol"
                  label="Âm lượng âm thanh gốc"
                  valuePct={originalAudioVolumePct}
                  onChangePct={setOriginalAudioVolumePct}
                />

                <AgyModelField value={agyModel} onChange={setAgyModel} />

                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="th-delogo">Xóa logo (x,y,w,h)</label>
                    <input
                      id="th-delogo"
                      className="input"
                      type="text"
                      value={delogo}
                      onChange={(e) => setDelogo(e.target.value)}
                      placeholder="none"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="th-subcover">Che phụ đề gốc (x,y,w,h)</label>
                    <input
                      id="th-subcover"
                      className="input"
                      type="text"
                      value={subcover}
                      onChange={(e) => setSubcover(e.target.value)}
                      placeholder="none"
                    />
                  </div>
                </div>

                <div className="form-grid">
                  <div className="field">
                    <label className="check" style={{ marginTop: 6 }}>
                      <input
                        type="checkbox"
                        checked={burnSub}
                        onChange={(e) => setBurnSub(e.target.checked)}
                      />
                      In cứng phụ đề Việt (font data/fonts/)
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="th-max-dur">Giới hạn thời lượng (giây)</label>
                    <input
                      id="th-max-dur"
                      className="input"
                      type="number"
                      min={10}
                      max={3600}
                      value={maxDurationSec}
                      onChange={(e) => setMaxDurationSec(Number(e.target.value) || 180)}
                    />
                  </div>
                </div>
              </>
            ) : (
              /* Mục riêng cho chế độ Chữ/Ảnh (VideoThreads) — Ẩn ở chế độ Video */
              <>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="th-theme">Giao diện thẻ Threads</label>
                    <select
                      id="th-theme"
                      className="select"
                      value={theme}
                      onChange={(e) => setTheme(e.target.value as "dark" | "light")}
                    >
                      <option value="dark">Tối (Dark)</option>
                      <option value="light">Sáng (Light)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="th-fps">Khung hình (FPS)</label>
                    <select
                      id="th-fps"
                      className="select"
                      value={String(fps)}
                      onChange={(e) => setFps(Number(e.target.value) === 30 ? 30 : 60)}
                    >
                      <option value="60">60 fps (Mượt)</option>
                      <option value="30">30 fps (Nhanh)</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="th-max-comments">Số bình luận tối đa (1–5)</label>
                  <input
                    id="th-max-comments"
                    className="input"
                    type="number"
                    min={1}
                    max={5}
                    value={maxComments}
                    onChange={(e) => setMaxComments(Math.min(5, Math.max(1, Number(e.target.value) || 5)))}
                  />
                </div>

                <div className="field">
                  <label htmlFor="th-bg-video">Video nền gameplay (tùy chọn)</label>
                  <input
                    id="th-bg-video"
                    className="input"
                    type="text"
                    placeholder="Mặc định: packages/threads/assets/gameplay/default.mp4"
                    value={bgVideoPath}
                    onChange={(e) => setBgVideoPath(e.target.value)}
                  />
                </div>

                <Callout tone="info" icon="info">
                  Chế độ Chữ/Ảnh không dùng thanh âm lượng gốc, xóa logo hay che phụ đề. Remotion preview chạy trên cổng <code>:3001</code>.
                </Callout>
              </>
            )}

            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" type="button" style={{ width: "100%" }} onClick={handleRun}>
                <Icon name="play" size={16} />{" "}
                {isVideoMode ? "Bắt đầu Reup Video Threads" : "Tạo Video từ bài Chữ/Ảnh"}
              </button>
            </div>
          </div>
        </aside>

        {/* Hàng dưới: Danh sách job Threads gần đây (SQLite data/openreup.db) */}
        <section className="studio-timeline" aria-label="Lịch sử tác vụ Threads" style={{ padding: "10px 16px", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Lịch sử tác vụ Threads ({jobs.length})</strong>
            <span className="muted" style={{ fontSize: 12 }}>Xuất tại downloads/threads/ · 1 GPU Queue chung</span>
          </div>
          {!jobs.length ? (
            <div className="muted" style={{ fontSize: 13 }}>Chưa có tác vụ Threads nào.</div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {jobs.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className={`btn btn-sm ${activeJob?.id === j.id ? "btn-primary" : "btn-light"}`}
                  onClick={() => setSelectedId(j.id)}
                  title={j.error || j.url || j.local_video_path}
                >
                  <span>{j.mode === "video_threads" ? "Chữ/Ảnh" : "Reup"}</span>
                  <span>·</span>
                  <span>{j.id}</span>
                  <span>({j.status})</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
