# Gom mỗi video vào một thư mục riêng

Bản thiết kế, giai đoạn 1. Tài liệu này chỉ mô tả hiện trạng và đề xuất. Chưa có dữ liệu thật nào được chuyển, chưa có code chạy nào bị sửa. Cần Techlead duyệt trước khi sang giai đoạn 2.

Số liệu đếm trên `data/` và `downloads/` thật ngày 2026-11-27, nhánh `claude` @ `0e6b04d`.

## 1. Hiện trạng: dữ liệu của một video nằm ở đâu

Hiện có 7 video nguồn trong `downloads/bilibili/`, 10 job lồng tiếng trong `data/dub_work/`, 7 bản xuất trong `downloads/dubbed/`, và 8 ảnh xem trước trong `data/thumbs/`.

### 1.1 File và thư mục gắn với một video nguồn

| Đường dẫn | Nội dung | Ai ghi | Ai đọc |
| --- | --- | --- | --- |
| `downloads/bilibili/<file>.mp4` (+ `.info.json`) | Video tải về từ Bilibili/YouTube | `download_bilibili.mjs:27`, in `SAVED_FILE:::` ở `:143` | `sources/service.mjs:84` (liệt kê), `util.mjs:46` `resolveDownload`, static `/downloads/` (`app.mjs:93`) |
| `downloads/<file>.mp4` | Video Douyin | `download_videos.mjs:21`, `:118`, `:127` | `sources/repo.mjs:21`, static `/downloads/` |
| `downloads/bilibili/<file>_delogo…` | Bản đã xóa logo | `sources/service.mjs:75` (tác vụ `bilibili_delogo`) | như trên |
| `data/bilibili.json` | Mục Bilibili, có `local_file` | script tải, `sources/repo.mjs:32-37` (xóa mục) | `sources/repo.mjs:30` |
| `data/videos.json` | Mục Douyin, có `local_file` | `download_videos.mjs` | `sources/repo.mjs` |
| `data/video_projects.json` | `{ "downloads/…/x.mp4": project_id }` | `store.mjs:16-27`, `migrate.mjs:43-51` | `store.mjs:12`, module `sources` và `project` (đếm video) |
| `data/media_cache.json` | ffprobe theo khóa `<đường dẫn tuyệt đối>\|size\|mtime` | `media.mjs:38` | `media.mjs:14` |
| `data/thumbs/<sha1(khóa trên)>.jpg` | Ảnh xem trước | `media.mjs:44-53` | `GET /api/thumb?rel=` (`sources/routes.mjs:24`) |

### 1.2 File và thư mục gắn với một job lồng tiếng

Một video có thể có nhiều job, ví dụ cùng video chạy ở 2 tốc độ `0p5x` và `0p65x`. Một job chỉ thuộc về một video nguồn.

| Đường dẫn | Nội dung | Ai ghi | Ai đọc |
| --- | --- | --- | --- |
| `data/dub_work/<job>/` (`meta.json`, `chunks/`, `parts/`, `tts/`) | Checkpoint, cache nhận diện và giọng đọc | `dub_video.py:328-335` (`Job`, mặc định `WORK_ROOT` `:55`) | `store.mjs:34-38` `dubWorkDirs`, `dub/repo.mjs:18-25` `readDubSources`, `store.mjs:45-60` (xóa), `migrate.mjs:72` |
| `data/dub_projects/<job>.json` | Lời dịch, tham số, `input_path` (tuyệt đối), `work_dir`/`out_dir` (tương đối với repo) | `dub_video.py:2040-2061`, `store.mjs:83-84` `saveDubProject` | `store.mjs:77-80`, `dub/service.mjs:62-71` `pathArgs`, `dub/functions.mjs:15` |
| `downloads/dubbed/<job>.mp4` + `.srt` | Bản xuất | `dub_video.py:1963-1964` (`DUB_OUT_DIR` `:50`, `--out-dir` `:1910`) | `dub/routes.mjs:33`, `dub/functions.mjs:17`, static `/downloads/dubbed/`, xóa ở `store.mjs:91-92` |
| `data/dubbed.json` | Danh sách bản xuất (`job_id`, `mp4_file`, `srt_file`, `project_id`, có thể có `work_dir`) | `dub_video.py:1786` `update_dubbed_index`, `:2118-2142`; `store.mjs:69-75` | `store.mjs:65`, `dubWorkDirs`, `migrate.mjs:45-60` |
| `data/openreup.db`: bảng `segments` và `timeline_dirty` theo `job_id` | Câu thoại, cờ "timeline đã đổi" | `dub_video.py:218` `save_segments`, `dub/routes.mjs` | `dub/routes.mjs`, xóa ở `store.mjs:96-97` |

Không gắn với video nào, nên ở nguyên chỗ cũ: `data/projects/` (dự án truyện), `voices/`, `fonts/`, `asr_models/`, `function_logs/`, `last_task.log`, bảng `function_calls`.

### 1.3 Những điểm làm việc chuyển dữ liệu khó hơn

- `job_id` tính từ **tên file nguồn**: `dub_<stem rút gọn>[_<sha1 6 ký tự>]_<speed>x`. Phía Python ở `dub_video.py:1899-1904`, phía Node ở `dub/service.mjs:20-26` `jobIdFor`. Nếu đổi tên file nguồn (ví dụ thành `source.mp4`), job mới sẽ mang id khác và có thể trùng với job của video khác.
- `input_path` trong `meta.json` và trong file dự án là **đường dẫn tuyệt đối**. `readDubSources` dùng nó để biết job thuộc video nào.
- `media_cache.json` và tên ảnh `thumbs/` khóa theo **đường dẫn tuyệt đối**. Dời file đi thì cache mất hiệu lực (sẽ tự tạo lại, không hỏng gì).
- Dữ liệu thật đang lệch nhau ở mấy chỗ, script chuyển phải xử lý được:
  - `dub_BV1wyxS62Etu_…_0p65x`: file nguồn không còn trong `downloads/bilibili/`, nhưng job và bản xuất vẫn còn.
  - `dub_qasandbox50_p1_0p5x`: `meta.json` không có `input_path`; file dự án trỏ tới `BV1nHW3z3EhH_p1__.mp4`, khác với tên mà `job_id` suy ra.
  - `dub_BV1nHW3z3EhH_*` (lỗi) và `dub_BVtest2_…_0p65x` (đã dừng) chỉ có thư mục làm việc, chưa có file dự án hay bản xuất.

## 2. Bố cục đề xuất

```
data/videos/<video_key>/
  video.json              # chỉ mục của video: key, rel_path cũ, nền tảng, id gốc, tiêu đề, project_id, danh sách job
  source/<tên gốc>.mp4    # giữ nguyên tên file gốc (+ .info.json, bản _delogo)
  thumb.jpg               # ảnh xem trước (+ media.json: ffprobe theo size|mtime)
  jobs/<job_id>/
    project.json          # nội dung data/dub_projects/<job>.json
    work/                 # nội dung data/dub_work/<job>/ (meta.json, chunks/, parts/, tts/)
    out/<job_id>.mp4      # bản xuất
    out/<job_id>.srt
```

`data/videos/` nằm dưới `REUP_DATA_DIR`, nên test tự đi theo thư mục tạm. Nếu video quá lớn để để trong `data/`, có thể thêm biến môi trường `REUP_VIDEOS_DIR` cho riêng thư mục này (mặc định là `data/videos`).

### 2.1 Chọn `video_key`

Khóa cần ổn định: không đổi khi đổi tiêu đề, khi xóa logo, hay khi tải lại.

1. Có id của nền tảng: `<nền tảng>-<id>-p<phần>`, chỉ gồm `[a-z0-9-]`. Ví dụ `bilibili-bv1nhw3z3ehh-p1`, `bilibili-4795815441340424-p1`, `douyin-<aweme_id>`. Id lấy từ `bilibili.json` / `videos.json` (`id`), hoặc từ phần đầu tên file `<id>_p<n>_…`.
2. Không có id (file tự đưa vào, video thử như `BVtest1_…`): `local-<sha1(rel_path cũ)[:12]>`. Khóa được tính một lần lúc chuyển rồi ghi vào `video.json`, sau đó không tính lại.
3. Trùng khóa (hiếm): thêm hậu tố `-2`, `-3`.

### 2.2 Một video, nhiều job

- `jobs/` chứa mọi job của video, mỗi job một thư mục `<job_id>` (ví dụ `…_0p5x` và `…_0p65x`).
- `job_id` **giữ nguyên** như cũ. DB, `dubbed.json`, API và giao diện đều dùng id này.
- Thư mục làm việc vẫn mang đúng tên `<job_id>` (đường dẫn `jobs/<job_id>/work/`, nhưng thư mục cha mang tên job). Điều kiện xóa an toàn của `dubWorkDir` (`store.mjs:45-55`) phải đổi từ "basename là jobId và nằm trong `data/dub_work/`" thành "là `data/videos/*/jobs/<jobId>/work`". Đây là mục còn mở trong checklist bước 6 của `docs/server-modules.md`.
- Job mất nguồn (`dub_BV1wyxS62Etu…`) hoặc không xác định được nguồn được gom vào `data/videos/_orphan/jobs/<job_id>/`. Không xóa job nào.

## 3. Giữ tương thích API

Mục tiêu: mọi JSON mà API trả về giống từng byte. DevFE không phải sửa gì.

- **`rel_path` giữ nguyên là khóa logic** `downloads/bilibili/<tên>.mp4`. Đây cũng là khóa của `video_projects.json`, `task.target` và `/api/thumb?rel=`. Server tra nó qua chỉ mục `rel_path → video_key` (dựng từ `video.json`, giữ trong bộ nhớ), sửa ở một chỗ duy nhất là `resolveDownload` (`util.mjs:46`). `relOf` làm việc ngược lại: đường dẫn thật trong `data/videos/` → `rel_path` cũ.
- **URL tĩnh `/downloads/...` giữ nguyên.** Giao diện đang tự ghép URL: `dubFileUrl = downloads/dubbed/<mp4_file>` (`web/lib/api.ts:27`), `douyinFileUrl` (`:28`), và `inputPath.slice("downloads/")` (`web/app/project/video/page.tsx:193`). Thay `fastifyStatic` ở `app.mjs:93` bằng một route `GET /downloads/*`:
  - `/downloads/dubbed/<job>.mp4|.srt` tra theo `job_id`;
  - các đường dẫn khác tra theo `rel_path`;
  - sau đó gọi `reply.sendFile` từ thư mục thật, giữ Range request và `Content-Type` của `.srt`.
- **`dubbed.json`, `video_projects.json`, `bilibili.json`, `videos.json` giữ nguyên dạng.** `local_file` và `mp4_file` vẫn là tên file như cũ. Riêng `work_dir`/`out_dir` trong file dự án và `dubbed.json` sẽ trỏ sang chỗ mới (xem mục kế tiếp).
- **`GET /api/dub/segments` trả nguyên file dự án** (`{ ...proj }`, `dub/routes.mjs:77-94`), gồm `input_path` (tuyệt đối; giao diện cắt từ `downloads/` ở `page.tsx:192-193`), `work_dir`, `out_dir`. Giao diện không đọc `work_dir`/`out_dir` (đã grep `web/`). Để giữ từng byte, route này trả 3 trường theo dạng cũ: `input_path` = `<MEDIA_ROOT>/downloads/...` suy từ `rel_path`; `work_dir` = `data/dub_work/<job>`; `out_dir` = `downloads/dubbed`. File trên đĩa vẫn lưu đường dẫn thật. Nếu Techlead chấp nhận để 3 trường này đổi, DevFE không phải sửa gì (chỉ dùng phần sau `downloads/` của `input_path`), nhưng cần kiểm lại `page.tsx:193`.
- Kết quả `/api/functions` (`files[].path`, `project_file`) hiện là đường dẫn tuyệt đối. Sau khi chuyển, trường này sẽ đổi thành đường dẫn thật mới. Đây là **thay đổi duy nhất** MausBot nhìn thấy: tên hàm và tham số không đổi, snapshot `/api/functions` không đổi.
- `/api/thumb` và `media_cache.json` chuyển sang `data/videos/<key>/thumb.jpg` và `media.json`. Ảnh được tạo lại khi cần; URL giữ nguyên.

Code server cần đổi (giai đoạn 2, module `dub`, `sources`, lớp dùng chung):

- `config.mjs`: thêm `VIDEOS_DIR`.
- `lib/util.mjs`: `resolveDownload`, `relOf`.
- `lib/store.mjs`: `dubWorkDirs`, `dubWorkDir`, `loadDubProject`, `saveDubProject`, `removeDubJob`.
- `dub/service.mjs`: `pathArgs` trỏ `--work-dir`, `--out-dir`, `--project-file` sang `jobs/<job>/`; `jobIdFor` nhận tên gốc từ `video.json` thay vì basename file.
- `sources/repo.mjs` + `service.mjs`: liệt kê theo `data/videos/*/video.json`; `SAVED_FILE:::` của script tải được chuyển vào thư mục video ngay khi tải xong (`lib/tasks.mjs:138`).
- `lib/media.mjs`: khóa cache theo `video_key`.
- `app.mjs`: route `/downloads/*`.

## 4. Script chuyển dữ liệu cũ (`scripts/migrate-video-folders.mjs`)

Chạy khi server đang tắt. Script từ chối chạy nếu có tác vụ đang chạy hoặc đang chờ (đọc trạng thái tác vụ, hoặc đơn giản là kiểm cổng 3456 có ai nghe không).

1. **Dry-run (mặc định).** Đọc mọi nguồn ở mục 1, dựng kế hoạch rồi in ra:
   - mỗi `video_key` gồm những file nào (từ → tới, kích thước);
   - job nào bị coi là mồ côi, và lý do;
   - các trường JSON sẽ sửa.

   Ghi kế hoạch vào `data/videos/_migration/plan-<thời điểm>.json`. Dry-run không đổi file nào ngoài file kế hoạch.
2. **Sao lưu** (`--apply`):
   - chép `dubbed.json`, `video_projects.json`, `bilibili.json`, `videos.json`, `media_cache.json`, toàn bộ `dub_projects/` (nhỏ), và một bản sao DB (`VACUUM INTO`) vào `data/videos/_migration/backup-<thời điểm>/`;
   - file media lớn **không chép** mà chuyển bằng `rename` (cùng ổ đĩa), để rollback chỉ cần `rename` ngược lại;
   - ghi nhật ký `moves.jsonl` (`{from, to, size}`) trước mỗi lần `rename`.
3. **Chạy** (`--apply`): chuyển theo kế hoạch, sửa `work_dir`/`out_dir` trong file dự án và `dubbed.json`, ghi `video.json`. Không đổi `job_id`, không đổi DB (bảng `segments` khóa theo `job_id`).
4. **Chạy lại không hỏng:**
   - file đã ở đích và đúng kích thước thì bỏ qua;
   - đích đã có nhưng khác kích thước thì dừng và báo, không ghi đè;
   - chạy hai lần liên tiếp thì lần sau báo "0 việc".
5. **Kiểm sau khi chạy** (`--verify`):
   - mọi `rel_path` cũ đều tra ra file thật;
   - mọi `job_id` trong `dubbed.json` và DB đều có `jobs/<job_id>/`;
   - tổng số byte trước và sau bằng nhau;
   - so JSON của `/api/sources`, `/api/dubbed`, `/api/projects` trước và sau (dựng app bằng `app.inject`, không cần mở cổng) phải giống từng byte.
6. **Quay lui** (`--rollback <backup-…>`): đọc `moves.jsonl` theo thứ tự ngược và `rename` về chỗ cũ, chép lại các file JSON và DB từ bản sao lưu, xóa thư mục `data/videos/<key>` nếu đã rỗng.

Test (`server/test/migrate-video-folders.test.mjs`) chạy trên thư mục tạm, dựng lại đúng các ca lệch ở mục 1.3. Các bước cần kiểm:

- dry-run không đổi file nào;
- apply rồi verify;
- apply lần hai thì báo 0 việc;
- rollback xong phải giống hệt lúc đầu (so cây file và nội dung).

Thứ tự giai đoạn 2:

1. Code server đọc được **cả hai bố cục**: tra `data/videos/` trước, không có thì tra chỗ cũ. Merge, kiểm.
2. Script chuyển: chạy dry-run trên dữ liệu thật để Techlead/PM xem, rồi mới apply.
3. Bỏ đường đọc bố cục cũ sau khi đã kiểm xong.

## 5. Phần việc của DevAI (Python)

- `dub_video.py:1899-1904`: thêm `--job-id`. Server luôn truyền tham số này. Nếu không có, vẫn suy từ tên file như cũ, để không đổi id khi file nguồn nằm ở `source/<tên gốc>.mp4`. Phía Node (`jobIdFor`) giữ đúng một công thức với Python.
- `dub_video.py:2040-2061` và `:2118-2142`: `input_path` ghi đúng đường dẫn nhận qua `--input`, không tự sửa. `work_dir`/`out_dir` vẫn ghi tương đối với repo. Server lo việc truyền đường dẫn mới qua `--work-dir`, `--out-dir`, `--project-file` (đã có sẵn từ `5199bda`).
- Các mặc định `WORK_ROOT`, `PROJECTS_DIR`, `DUB_OUT_DIR` (`dub_video.py:50-55`) giữ nguyên trong giai đoạn đọc cả hai bố cục. Chỉ đổi sau khi đã chuyển dữ liệu.
- `download_bilibili.mjs` / `download_videos.mjs` (Node nhưng là script tải): có thể giữ chỗ tải về cũ. Server chuyển file vào `data/videos/<key>/source/` khi đọc được `SAVED_FILE:::`.

## 6. Phần việc của DevFE

Nếu Techlead duyệt phương án ở mục 3 (giữ `rel_path`, URL `/downloads/...` và 3 trường đường dẫn của `/api/dub/segments` theo dạng cũ), DevFE **không phải sửa gì**.

Chỉ phải sửa nếu Techlead chọn đổi `input_path` hoặc URL tĩnh. Khi đó các chỗ cần đổi:

- `web/lib/api.ts:25-28` (`fileUrl`, `dubFileUrl`, `douyinFileUrl`);
- `web/app/project/video/page.tsx:191-193`;
- `web/app/help/page.tsx:12-14` (bảng giải thích các thư mục).

Trang trợ giúp nên được cập nhật dòng "Bản lồng tiếng nằm ở đâu" sau khi chuyển dữ liệu, kể cả khi API không đổi.

## 7. Cần Techlead quyết

1. `data/videos/` nằm dưới `REUP_DATA_DIR`, có thêm `REUP_VIDEOS_DIR` tùy chọn. Hay đặt dưới `REUP_MEDIA_ROOT`?
2. `/api/dub/segments` trả `input_path`/`work_dir`/`out_dir` theo dạng cũ (đề xuất, giống từng byte), hay trả đường dẫn thật mới?
3. Chấp nhận việc kết quả `/api/functions` (đường dẫn file tuyệt đối) đổi sang chỗ mới?
