# Module hóa `server/`

Thêm chức năng = thêm 1 thư mục `server/modules/<tên>/` rồi thêm module đó vào `MODULES` trong `server/app.mjs`.

| File | Việc |
| --- | --- |
| `index.mjs` | `{ name, deps, init(ctx) -> service, routes, functions }` cho `server/core/loader.mjs` |
| `routes.mjs` | `routes(app, ctx, service)`: chỉ đọc request, gọi service, trả JSON |
| `service.mjs` | Nghiệp vụ; lỗi do input ném `Error` có `statusCode` |
| `repo.mjs` | Đọc/ghi file JSON / DB của module |
| `functions.mjs` | Hàm `/api/functions` của module; đặt `{ slot: "<tên>" }` (cả nhóm) hoặc `{ ref: "<tên hàm>" }` (từng hàm nằm xen kẽ) trong `server/routes/functions.mjs` để giữ thứ tự |

- Module khác chỉ dùng service qua `ctx.get(tên)` và phải khai tên đó trong `deps`.
- Nghe sự kiện dùng chung (`taskEvents`...) qua `ctx.listen(emitter, event, fn)`: loader gỡ hết listener khi app đóng (`app.close()`).
- Đổi `/api/functions` có chủ đích: `UPDATE_SNAPSHOT=1 npm run test:api`, rồi báo FE/MausBot.

| Module | Trạng thái |
| --- | --- |
| project | đã tách (`server/modules/project/`), `deps: ["dub"]` |
| dub | đã tách (`server/modules/dub/`): route → `editor.mjs` (danh sách đã lồng tiếng, gán/bỏ gán dự án có kiểm dự án tồn tại, dọn cache, xóa, sửa câu thoại) → repo; route không còn SQL/nghiệp vụ |
| sources | đã tách (`server/modules/sources/`), `deps: ["dub", "project"]`; job lồng tiếng của video nguồn lấy qua `ctx.get("dub")` (`jobsBySource`, `removeWorkDir`, `removeJob`, `busyError`); ảnh thu nhỏ / khung hình (`thumb`, `frame`) nằm trong service |
| resources | đã tách (`server/modules/resources/`), `deps: ["ai", "dub", "project", "sources"]` (`ai`: `list_options` đọc `/api/agy-models`); font, giọng đọc, mô hình nhận diện (danh sách `asr.py list` cache 30 s, bỏ cache khi đổi VAD / tải mô hình xong), xem trước phụ đề, hàm `list_options` (gộp `routes/voices.mjs` + `routes/resources.mjs` + `lib/voices.mjs`). Giọng của dự án qua `ctx.get("project")` (`addVoice`, `dropVoice`), video nguồn qua `ctx.get("sources").fileOf`, chặn xóa khi đang lồng tiếng qua `ctx.get("dub").busyError`. `lib/fonts.mjs` chỉ còn `checkSubStyle`/`validFontFamily` dùng chung với `dub`. Mọi file ghi ra nằm dưới `REUP_DATA_DIR` (`fonts/`, `fonts.json`, `voices/`, `voices.json`) |
| ai | đã tách (`server/modules/ai/`, thay `lib/agy.mjs`), không phụ thuộc module nào; `dub` khai `deps: ["ai"]` và kiểm `agy_model` qua `ctx.get("ai").validModel`. Route `/api/agy-models`, `/api/agy-models/refresh`; hàm `refresh_ai_models` (`functions.mjs`, slot `ai` sau `tasks`); cache `<REUP_DATA_DIR>/agy_models.json`; lệnh agy lấy từ `AGY_BIN` (test dùng agy giả) |
| tasks | đã tách (`server/modules/tasks/`, thay `routes/tasks.mjs`): `/api/task*`, `/api/system` (dung lượng ổ qua `service.mjs`), hàm `get_task`, `stop_task`, `get_call`, `list_calls`. Nhật ký lần gọi (bảng `function_calls`) ở `server/lib/function-calls.mjs`, dùng chung với lớp chạy hàm |
| functions | `server/routes/functions.mjs` chỉ còn danh sách đăng ký (`FUNCTIONS`: `{ slot }` / `{ ref }`) + lớp chạy hàm `/api/functions*`; không khai hàm riêng |

### Ranh giới module `ai`

`ai` chỉ giữ phần server tự làm với AI: danh sách model dịch của Antigravity (gọi `agy models`, cache, gom theo mức suy nghĩ) và kiểm tra id model. Những phần dưới đây cố ý không chuyển vào:

- Dịch và nhận diện giọng nói chạy trong `pipeline/` (điều phối bởi `pipeline/dub_video.py`, đường dẫn script lấy từ hằng số `PY_SCRIPTS` trong `config.mjs`), do module `dub` khởi chạy; server không gọi model nào trực tiếp. Tách ra thì `ai` chỉ còn bọc lại việc chạy script của `dub`.
- Mô hình nhận diện (`/api/asr-models*`, hàm `download_asr_model`) là tài nguyên tải về máy giống font và giọng đọc, nên ở lại `resources` (đã duyệt ở `a6b5c40`).
- `list_options` gom giá trị hợp lệ của nhiều module (giọng, mô hình nhận diện, model dịch, dự án, font) qua HTTP (không import module khác), nằm ở `resources`. `get_task`, `stop_task`, `get_call`, `list_calls` thuộc module `tasks`.
- Hàm `/api/functions` duy nhất của `ai` là `refresh_ai_models` (gọi `/api/agy-models/refresh`); danh sách sau khi làm mới đọc lại qua `list_options.agy_models`.

Khi `ai` được nạp trước `dub`, cây route mà `printRoutes()` in ra đổi thứ tự hiển thị (`/api/agy-models` và `/api/asr-models` lên đầu nhóm `/api/a…`). Tập route (đường dẫn + method) vẫn giữ nguyên.

## Checklist bước 6 (module `dub`)

- [x] `readDubSources` / `readDubJobs` đọc `meta.json` theo `work_dir` ghi trong `dubbed.json` (`dubWorkDirs()` trong `lib/store.mjs`).
- [x] Module `dub` luôn truyền `--work-dir --out-dir --project-file --index-file --story-dir` (`service.pathArgs`), kể cả khi chạy tiếp; dùng lại `work_dir`/`out_dir` đã lưu trong file project của job.
- [x] Chặn xóa dự án khi có job lồng tiếng của dự án đang chạy hoặc chờ (409).
- [x] `project` lấy bản lồng tiếng qua `ctx.get("dub")`, không import thẳng `lib/store` phần lồng tiếng.
- [ ] Bước 6: sau khi `rename` thư mục video, cập nhật `work_dir`/`out_dir` trong file project của job và trong `dubbed.json`.
- [ ] Thư mục làm việc của job phải giữ đúng tên `<jobId>` khi đổi chỗ (ví dụ `<thư mục video>/<jobId>/`). `dubWorkDir` (`lib/store.mjs`) chỉ nhận thư mục có `basename(realpath) === jobId` nằm trong `data/dub_work/`; đặt tên khác hoặc dời ra ngoài thì `/api/dub/clean`, `/api/dub/delete` và lệnh xóa video nguồn lặng lẽ không xóa gì. Bước 6 phải mở rộng điều kiện gốc cho phép (không chỉ `data/dub_work/`) cùng lúc với việc dời thư mục.
- [x] `pipeline/dub_video.py` mở SQLite theo `REUP_DATA_DIR` (`<REUP_DATA_DIR>/openreup.db`), qua `pipeline/paths.py`.

## Thư mục dữ liệu khi chạy test

| Biến môi trường | Mặc định | Đổi gì |
| --- | --- | --- |
| `REUP_DATA_DIR` | `data/` trong repo | DB, các file JSON, `projects/`, `dub_projects/`, `dub_work/`, `voices/`, `fonts/`, `asr_models/`, `asr_settings.json` (cả phía Node lẫn script Python) |
| `REUP_MEDIA_ROOT` | thư mục repo | Thư mục chứa `downloads/`: video tải về và bản xuất `downloads/dubbed` (`--out-dir` của `dub_video.py`). Đường dẫn `downloads/...` trong API và `video_projects.json` tính từ đây. |
| `REUP_PYTHON` | `.venv/bin/python` | Thay Python bằng script giả |

`server/test/helpers.mjs` (`setupApp`) đặt `REUP_DATA_DIR` và `REUP_MEDIA_ROOT` cùng trỏ vào một thư mục tạm trong `/tmp`. Hàm này phải chạy trước mọi import của server, vì `config.mjs` đọc các biến môi trường ngay lúc nạp. Server thật không đặt 2 biến này. Nếu đặt, cả hai biến phải là đường dẫn tuyệt đối: script con (Python, script tải) chạy với `cwd` khác nhau nên đường dẫn tương đối sẽ trỏ sai chỗ.

Script tải `download_videos.mjs` (Douyin), `download_bilibili.mjs` (Bilibili/YouTube) và `list_channel_web.mjs` chạy như tiến trình con, kế thừa env của server nên cũng ghi theo `REUP_MEDIA_ROOT` (`downloads/`) và `REUP_DATA_DIR` (`videos.json`, `bilibili.json`). `lib/tasks.mjs` tính đường dẫn `SAVED_FILE:::` từ `MEDIA_ROOT`. Còn dùng thư mục repo: `chrome_profile/` (đăng nhập Douyin) và `cookies.txt`.

Script Python (`pipeline/dub_video.py`, `pipeline/asr.py`, `pipeline/subtitles.py`, `pipeline/voice_tool.py`, `list_channel_adb.py`) lấy thư mục từ `pipeline/paths.py`, đọc cùng `REUP_DATA_DIR`/`REUP_MEDIA_ROOT` như `config.mjs` (mặc định `data/` và thư mục repo, server thật không đổi). Server chạy script con với `...process.env` nên script tự theo thư mục tạm của test: `asr.py set-vad/download` ghi `asr_models/` + `asr_settings.json`, `dub_video.py` mở `openreup.db`, đọc `voices/`, `projects/`, `dubbed.json`, `dub_work/` và xuất mặc định vào `<REUP_MEDIA_ROOT>/downloads/dubbed`, `subtitles.py` tìm font trong `fonts/`. Thư mục script cụ thể vẫn ghi đè được qua `--out-dir`, `--work-dir`, `--index-file`... `pipeline/tests/test_dub_video.py` (`test_reup_data_dir_*`) kiểm cả hai trường hợp có và không đặt biến.
