# Module hóa `server/`

Thêm chức năng = thêm 1 thư mục `server/modules/<tên>/` rồi thêm module đó vào `MODULES` trong `server/app.mjs`.

| File | Việc |
| --- | --- |
| `index.mjs` | `{ name, deps, init(ctx) -> service, routes, functions }` cho `server/core/loader.mjs` |
| `routes.mjs` | `routes(app, ctx, service)`: chỉ đọc request, gọi service, trả JSON |
| `service.mjs` | Nghiệp vụ; lỗi do input ném `Error` có `statusCode` |
| `repo.mjs` | Đọc/ghi file JSON / DB của module |
| `functions.mjs` | Hàm `/api/functions` của module; đặt `{ slot: "<tên>" }` trong `server/routes/functions.mjs` để giữ thứ tự |

- Module khác chỉ dùng service qua `ctx.get(tên)` và phải khai tên đó trong `deps`.
- Đổi `/api/functions` có chủ đích: `UPDATE_SNAPSHOT=1 npm run test:api`, rồi báo FE/MausBot.

| Module | Trạng thái |
| --- | --- |
| project | đã tách (`server/modules/project/`) |
| tasks, source, voices, resources, dub, functions | còn bọc `server/routes/*.mjs` |

## Checklist bước 6 (module `dub`)

- [ ] `readDubSources` đọc `meta.json` theo `work_dir` ghi trong `dubbed.json` (không quét cứng `data/dub_work/`).
- [ ] Module `dub` luôn truyền `--work-dir` cho `dub_video.py`, kể cả khi chạy tiếp (resume).
- [ ] Chặn xóa dự án khi đang có task chạy của dự án đó.
