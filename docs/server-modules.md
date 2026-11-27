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
| tasks, source, voices, resources, functions | còn bọc `server/routes/*.mjs` |

## Checklist bước 6 (module `dub`)

- [x] `readDubSources` / `readDubJobs` đọc `meta.json` theo `work_dir` ghi trong `dubbed.json` (`dubWorkDirs()` trong `lib/store.mjs`).
- [x] Module `dub` luôn truyền `--work-dir --out-dir --project-file --index-file --story-dir` (`service.pathArgs`), kể cả khi chạy tiếp; dùng lại `work_dir`/`out_dir` đã lưu trong file project của job.
- [x] Chặn xóa dự án khi có job lồng tiếng của dự án đang chạy hoặc chờ (409).
- [x] `project` lấy bản lồng tiếng qua `ctx.get("dub")`, không import thẳng `lib/store` phần lồng tiếng.
- [ ] Bước 6: sau khi `rename` thư mục video, cập nhật `work_dir`/`out_dir` trong file project của job và trong `dubbed.json`.
- [ ] `dub_video.py` vẫn mở SQLite theo đường dẫn cố định (`data/openreup.db`), chưa theo `REUP_DATA_DIR`.

## Thư mục dữ liệu khi chạy test

| Biến môi trường | Mặc định | Đổi gì |
| --- | --- | --- |
| `REUP_DATA_DIR` | `data/` trong repo | DB, các file JSON, `projects/`, `dub_projects/`, `dub_work/` |
| `REUP_MEDIA_ROOT` | thư mục repo | Thư mục chứa `downloads/`: video tải về và bản xuất `downloads/dubbed` (`--out-dir` của `dub_video.py`). Đường dẫn `downloads/...` trong API và `video_projects.json` tính từ đây. |
| `REUP_PYTHON` | `.venv/bin/python` | Thay Python bằng script giả |

`server/test/helpers.mjs` (`setupApp`) đặt `REUP_DATA_DIR` và `REUP_MEDIA_ROOT` cùng trỏ vào một thư mục tạm trong `/tmp`. Hàm này phải chạy trước mọi import của server, vì `config.mjs` đọc các biến môi trường ngay lúc nạp. Server thật không đặt 2 biến này.
