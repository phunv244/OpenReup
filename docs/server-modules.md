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
- Đổi `/api/functions` có chủ đích: `UPDATE_SNAPSHOT=1 npm run test:api`, rồi báo FE/MausBot.

| Module | Trạng thái |
| --- | --- |
| project | đã tách (`server/modules/project/`), `deps: ["dub"]` |
| dub | đã tách (`server/modules/dub/`); các route sửa câu thoại vẫn gọi DB trực tiếp trong `routes.mjs` |
| sources | đã tách (`server/modules/sources/`), `deps: ["dub", "project"]`; job lồng tiếng của video nguồn lấy qua `ctx.get("dub")` (`jobsBySource`, `removeWorkDir`, `removeJob`, `busyError`) |
| resources | đã tách (`server/modules/resources/`), `deps: ["dub", "project", "sources"]`; font, giọng đọc, mô hình nhận diện, xem trước phụ đề (gộp `routes/voices.mjs` + `routes/resources.mjs` + `lib/voices.mjs`). Giọng của dự án qua `ctx.get("project")` (`addVoice`, `dropVoice`), video nguồn qua `ctx.get("sources").fileOf`, chặn xóa khi đang lồng tiếng qua `ctx.get("dub").busyError`. `lib/fonts.mjs` chỉ còn `checkSubStyle`/`validFontFamily` dùng chung với `dub`. Mọi file ghi ra nằm dưới `REUP_DATA_DIR` (`fonts/`, `fonts.json`, `voices/`, `voices.json`) |
| tasks, functions | còn bọc `server/routes/*.mjs` |

## Checklist bước 6 (module `dub`)

- [x] `readDubSources` / `readDubJobs` đọc `meta.json` theo `work_dir` ghi trong `dubbed.json` (`dubWorkDirs()` trong `lib/store.mjs`).
- [x] Module `dub` luôn truyền `--work-dir --out-dir --project-file --index-file --story-dir` (`service.pathArgs`), kể cả khi chạy tiếp; dùng lại `work_dir`/`out_dir` đã lưu trong file project của job.
- [x] Chặn xóa dự án khi có job lồng tiếng của dự án đang chạy hoặc chờ (409).
- [x] `project` lấy bản lồng tiếng qua `ctx.get("dub")`, không import thẳng `lib/store` phần lồng tiếng.
- [ ] Bước 6: sau khi `rename` thư mục video, cập nhật `work_dir`/`out_dir` trong file project của job và trong `dubbed.json`.
- [ ] Thư mục làm việc của job phải giữ đúng tên `<jobId>` khi đổi chỗ (ví dụ `<thư mục video>/<jobId>/`). `dubWorkDir` (`lib/store.mjs`) chỉ nhận thư mục có `basename(realpath) === jobId` nằm trong `data/dub_work/`; đặt tên khác hoặc dời ra ngoài thì `/api/dub/clean`, `/api/dub/delete` và lệnh xóa video nguồn lặng lẽ không xóa gì. Bước 6 phải mở rộng điều kiện gốc cho phép (không chỉ `data/dub_work/`) cùng lúc với việc dời thư mục.
- [ ] `dub_video.py` vẫn mở SQLite theo đường dẫn cố định (`data/openreup.db`), chưa theo `REUP_DATA_DIR`.

## Thư mục dữ liệu khi chạy test

| Biến môi trường | Mặc định | Đổi gì |
| --- | --- | --- |
| `REUP_DATA_DIR` | `data/` trong repo | DB, các file JSON, `projects/`, `dub_projects/`, `dub_work/` |
| `REUP_MEDIA_ROOT` | thư mục repo | Thư mục chứa `downloads/`: video tải về và bản xuất `downloads/dubbed` (`--out-dir` của `dub_video.py`). Đường dẫn `downloads/...` trong API và `video_projects.json` tính từ đây. |
| `REUP_PYTHON` | `.venv/bin/python` | Thay Python bằng script giả |

`server/test/helpers.mjs` (`setupApp`) đặt `REUP_DATA_DIR` và `REUP_MEDIA_ROOT` cùng trỏ vào một thư mục tạm trong `/tmp`. Hàm này phải chạy trước mọi import của server, vì `config.mjs` đọc các biến môi trường ngay lúc nạp. Server thật không đặt 2 biến này.

Script tải `download_videos.mjs` (Douyin), `download_bilibili.mjs` (Bilibili/YouTube) và `list_channel_web.mjs` chạy như tiến trình con, kế thừa env của server nên cũng ghi theo `REUP_MEDIA_ROOT` (`downloads/`) và `REUP_DATA_DIR` (`videos.json`, `bilibili.json`). `lib/tasks.mjs` tính đường dẫn `SAVED_FILE:::` từ `MEDIA_ROOT`. Còn dùng thư mục repo: `chrome_profile/` (đăng nhập Douyin) và `cookies.txt`.

`asr.py` (`set-vad`, `download`) vẫn ghi theo thư mục cố định `data/asr_models/` cạnh script, chưa theo `REUP_DATA_DIR`: test mô hình nhận diện thật sẽ ghi vào `data/` thật. Test API dùng Python giả (`REUP_PYTHON`) nên không chạm tới. `voice_tool.py` và `subtitles.py` nhận đường dẫn ra qua `--out` nên đã theo thư mục tạm.
