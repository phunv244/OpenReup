# OpenReup — Code Mode SDK, Skill, Rule & Tool Reference

Tài liệu chuẩn hóa toàn bộ **Skill / Rule / Tool** và **Code Mode SDK** cho hệ thống `OpenReup` tích hợp module **Threads** (**VideoThreads** + **ReupThreads**) theo **Phương án A (Gate 3)**.

---

## 1. Kiến trúc & Quy tắc vận hành (Rules)

| Thành phần | Đường dẫn | Quy tắc bắt buộc |
|---|---|---|
| Subpackage cô lập | `packages/threads/` (`@openreup/threads`) | Cô lập Remotion 4.0.547 + React 18 khỏi Next.js 16 + React 19; mọi đường dẫn đều resolve động qua `src/paths.ts` (0 path hardcode). |
| Backend Plugin | `server/modules/threads/` | Đủ 5 file (`index.mjs`, `routes.mjs`, `service.mjs`, `repo.mjs`, `functions.mjs`), đăng ký vào `server/app.mjs` và `server/routes/functions.mjs`. |
| Cơ sở dữ liệu | `data/openreup.db` (`node:sqlite` WAL) | Bảng `threads_jobs` dùng chung kết nối SQLite WAL với `OpenReup`. |
| Hàng đợi GPU | `server/lib/tasks.mjs` (`spawnTask`) | **1 GPU Queue duy nhất** toàn hệ thống; bỏ hoàn toàn sidecar `:23334`. |
| Thư mục xuất | `downloads/threads/` | Mọi video xuất từ `VideoThreads` và `ReupThreads` lưu tại đây, phát `SAVED_FILE:::downloads/threads/<file>.mp4`. |
| Remotion Studio | Cổng `:3001` | `npm --prefix packages/threads run preview` (tránh xung đột Next.js `:3000` và Fastify `:3456`). |
| Giới hạn thời lượng | Mặc định `<= 180s` | Video vượt giới hạn trả `ERR_VIDEO_TOO_LONG`. |
| Chuẩn âm thanh | `48 kHz` Stereo PCM, `-14 LUFS` | Áp dụng `loudnorm=I=-14:TP=-1.0:LRA=11` ở bước master. |

### Quy tắc DSP âm thanh gốc (`originalAudioVolumePct`: `0–200`)
- Giá trị hợp lệ: số hữu hạn trong đoạn `[0, 200]`. Ngoài biên trả **`ERR_VALIDATION_FAILED`**.
- **`0`**: Tắt hoàn toàn track âm thanh gốc (chỉ giữ giọng lồng tiếng).
- **`1–100`**: Giảm tỷ lệ tuyến tính (`volume = pct / 100`) + `sidechaincompress` ducking theo track giọng đọc.
- **`101–200`**: Khuếch đại (`volume = pct / 100`) + **`alimiter=limit=0.891:attack=5:release=50:level=disabled`** + `sidechaincompress` ducking, giữ chuẩn đầu ra `-14 LUFS`.
- **4 Preset chuẩn trên Web UI (`step=5`):** `0%` Tắt · `20%` Nền nhẹ · `100%` Gốc · `150%` Kích lớn (khi `> 100%` hiện cảnh báo `var(--amber)` & badge `Khuếch đại · Có limiter`).

---

## 2. Giao thức CLI Worker (`packages/threads/dist/cli.js`)

Server gọi worker bằng `node packages/threads/dist/cli.js <command> [flags]` thông qua `spawnTask`:
- `video-threads`: Chạy pipeline VideoThreads (chữ/ảnh → MP4 1080×1920 @ 60fps).
- `reup-threads`: Chạy pipeline ReupThreads 6 bước tuần tự (`INGEST -> PROBE -> TRANSCRIBE -> ADAPT_SCRIPT -> DUB_AND_MASTER -> RENDER_EXPORT`).
- `scrape`: Cào bài viết Threads 2 tầng.
- `extract-video`: Trích xuất và tải video từ bài viết Threads.
- `probe-nvenc`: Kiểm tra nhanh 0.2s `h264_nvenc` (fallback `libx264`).

Chuẩn stdout:
- Tiến độ: `@@PROGRESS {"pct":<0-100>,"label":"<mô tả>","eta":null,"stage":<0-6>}`
- File xuất: `SAVED_FILE:::downloads/threads/<filename>.mp4`
- Kết quả JSON: `@@RESULT {"ok":true,"data":{...}}`

---

## 3. MCP & REST Function Calling (`/api/functions` + `mcp-server.mjs`)

4 tool mới của module `threads` (tự động lộ qua `GET /api/functions` và `node mcp-server.mjs`):

| Tên tool | Route nội bộ | Chạy nền | Mô tả |
|---|---|---|---|
| `threads_video_pipeline` | `POST /api/threads/video` | Có (`spawnTask`) | Tạo video dọc 9:16 60fps từ bài chữ/ảnh Threads (VideoThreads + Remotion). |
| `threads_reup_pipeline` | `POST /api/threads/reup` | Có (`spawnTask`) | Reup video Threads 6 bước, hỗ trợ `original_audio_volume_pct` `0–200`, `delogo`, `subcover`, `burn_sub`, `agy_model`. |
| `threads_scrape_post` | `POST /api/threads/scrape` | Có (`spawnTask`) | Cào bài viết Threads 2 tầng (trả `ERR_VIDEO_ONLY_POST` nếu bài chỉ có video). |
| `threads_list_jobs` | đọc `threads_jobs` | Không (`nolog`) | Liệt kê lịch sử job Threads từ `data/openreup.db`. |

---

## 4. Code Mode SDK (`packages/threads/src/code-mode/`)

Mọi hàm đều trả về `CodeModeResult<T>` (`{ ok, success, data | error, meta: { traceId, durationMs, warnings } }`).

### 4.1. 16 hàm VideoThreads (khớp 100% export thực tế tại `packages/threads/dist/code-mode/index.js`)
1. `initLocalDatabase` (`core.ts`)
2. `listAvailableVoices` (`core.ts`)
3. `parseAndValidateThreadsUrl` (`scraper.ts`)
4. `scrapeThreadsPost` (`scraper.ts`) — trả `ERR_VIDEO_ONLY_POST` cho bài chỉ chứa video.
5. `prefetchAndOptimizeImages` (`scraper.ts`)
6. `normalizeVietnameseTtsText` (`director.ts`)
7. `directVideoScript` (`director.ts`) — không có bước scoring.
8. `synthesizeVoiceSegments` (`audio.ts`)
9. `extractAndProbeMedia` (`audio.ts`)
10. `mixMasterAudio` (`audio.ts`)
11. `buildVideoCompositionProps` (`remotion.ts`)
12. `validateCompositionProps` (`remotion.ts`)
13. `renderPreviewStill` (`remotion.ts`)
14. `renderThreadsVideo` (`remotion.ts`)
15. `openVideoPreview` (`remotion.ts`)
16. `runThreadsVideoPipeline` (`pipeline.ts`) — trả `ERR_VIDEO_ONLY_POST` cho bài chỉ chứa video.

*(Ngoài ra `types.ts` export 2 helper bao bọc: `runCodeMode`, `toCodeModeError`.)*

### 4.2. 4 hàm ReupThreads mới (`code-mode/reup.ts`)
1. **`extractThreadsVideo(options)`** — Cào 2 tầng, chọn `video_versions` độ phân giải cao nhất, tải MP4 và kiểm tra giới hạn thời lượng (`<= 180s`).
2. **`runReupThreadsPipeline(options)`** — Chạy 6 bước tuần tự có checkpoint (`checkpoint.json` + `adapt_script.json`):
   `INGEST -> PROBE -> TRANSCRIBE -> ADAPT_SCRIPT -> DUB_AND_MASTER -> RENDER_EXPORT`
   - Hỗ trợ `originalAudioVolumePct` (`0–200`, ngoài biên `ERR_VALIDATION_FAILED`), `delogo`, `subcover`, burn phụ đề từ `data/fonts/`, `probeNvenc` fallback `libx264`.
3. **`probeReupNvenc(options?)`** — Kiểm tra thực tế 0.2s `h264_nvenc`, trả `{ available, encoder, reason }`.
4. **`buildOriginalAudioDspFilter({ originalAudioVolumePct })`** — Kiểm chứng và sinh chuỗi filter FFmpeg (`volume` + `alimiter` khi `>100%`).

---

## 5. Lệnh kiểm thử & Build chuẩn

```bash
# 1. Subpackage packages/threads
npm --prefix packages/threads run typecheck
npm --prefix packages/threads run build
npm --prefix packages/threads test

# 2. Backend API tests (OpenReup)
npm run test:api

# 3. Python pipeline tests
npm test

# 4. Web UI Next.js build (static export)
npm run build:web
```
