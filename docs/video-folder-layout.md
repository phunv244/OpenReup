# Gom mỗi video vào một thư mục riêng

> Ghi chú: `dub_video.py` nay nằm ở `pipeline/dub_video.py` và được tách theo bước (`pipeline/stt.py`, `translate.py`, `tts.py`, `mix.py`, `render.py`, `store.py`, `job.py`...). Số dòng `dub_video.py:NNNN` trong tài liệu này là của bản trước khi tách (commit `f4b2acb`).

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

`data/videos/` nằm dưới `REUP_DATA_DIR`, nên test tự đi theo thư mục tạm. **Không** thêm `REUP_VIDEOS_DIR` ở giai đoạn 2 (Techlead, mục 8.1).

### 2.1 Chọn `video_key`

Khóa cần ổn định: không đổi khi đổi tiêu đề, khi xóa logo, hay khi tải lại.

1. Có id của nền tảng: `<nền tảng>-<id>-p<phần>`, chỉ gồm `[A-Za-z0-9-]`, **giữ nguyên hoa/thường của id** (BV id là base58, phân biệt hoa thường; hạ chữ thường có thể làm 2 video trùng khóa). Ví dụ `bilibili-BV1nHW3z3EhH-p1`, `bilibili-4795815441340424-p1`, `douyin-<aweme_id>`. Id lấy từ `bilibili.json` / `videos.json` (`id`), hoặc từ phần đầu tên file `<id>_p<n>_…`.
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

Chạy khi **mọi** server đang tắt. Kiểm cổng 3456 là không đủ: xem mục 8.3, ý 1.

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

## 7. Cần Techlead quyết (đã quyết, xem 8.1)

1. `data/videos/` nằm dưới `REUP_DATA_DIR`, có thêm `REUP_VIDEOS_DIR` tùy chọn. Hay đặt dưới `REUP_MEDIA_ROOT`?
2. `/api/dub/segments` trả `input_path`/`work_dir`/`out_dir` theo dạng cũ (đề xuất, giống từng byte), hay trả đường dẫn thật mới?
3. Chấp nhận việc kết quả `/api/functions` (đường dẫn file tuyệt đối) đổi sang chỗ mới?

## 8. Techlead duyệt (2026-11-27)

**Kết luận: CẦN SỬA, đã sửa ngay trong tài liệu này.** Hướng thiết kế đúng (giữ `job_id`, giữ `rel_path` làm khóa logic, đọc được cả hai bố cục, chuyển bằng `rename` có nhật ký). Sau các sửa ở 8.1–8.4, thiết kế **ĐẠT** để vào giai đoạn 2 theo đúng thứ tự ở 8.5.

### 8.1 Quyết định 3 điểm ở mục 7

1. **`data/videos/` nằm dưới `REUP_DATA_DIR` (`DATA_DIR/videos`). Bỏ `REUP_VIDEOS_DIR`.** Test chỉ cần `REUP_DATA_DIR` là cách ly. Thêm một biến nữa thì có thêm cách để test ghi nhầm vào dữ liệu thật, và có thể làm `videos/` và `downloads/` nằm trên hai ổ khác nhau (khi đó `rename` lỗi `EXDEV`). Khi nào cần đổi ổ thì thêm sau, kèm bước chép có kiểm tra.
   - Hệ quả: `REUP_MEDIA_ROOT` chỉ còn giữ `downloads/` cũ (đọc cả hai bố cục, và chỗ script tải ghi vào). Test nào chỉ đặt `REUP_MEDIA_ROOT` mà quên `REUP_DATA_DIR` sẽ ghi vào `data/` thật: helper test phải đặt **cả hai**, và helper phải tự kiểm `DATA_DIR !== ROOT/data` trước khi chạy.
2. **`/api/dub/segments` trả 3 trường theo dạng cũ** (đồng ý với PM). Lưu ý:
   - Chiếu ngược chỉ làm ở lớp route (`dub/routes.mjs`), không ghi đè lên file.
   - File trên đĩa (`project.json`, `work/meta.json`) giữ **đường dẫn thật mới**. Lý do: Python đọc `input_path` từ file dự án khi xuất lại (`dub_video.py:1865-1870`).
   - Job mồ côi không có `rel_path`: trả nguyên giá trị đã lưu.
3. **Chấp nhận `files[].path` và `project_file` của `/api/functions` đổi sang chỗ mới.** Trường `path` dùng để mở file, nên phải là đường dẫn có thật. Trả đường dẫn cũ (không còn file) thì MausBot sẽ hỏng. Để giữ nguyên thì chỉ còn cách symlink, nhưng như vậy là lại có hai chỗ cho một file. Những gì MausBot dùng để gọi tiếp thì giữ nguyên: tên hàm, tham số, `job_id`, `rel_path`, `url` (`relOf` của file xuất mới phải ra `downloads/dubbed/<job>.mp4`). Snapshot schema `/api/functions` không đổi.

### 8.2 Bản kê: những chỗ đọc/ghi còn thiếu (đã đối chiếu code @ `18ac139`)

| Chỗ | Vấn đề | Xử lý |
| --- | --- | --- |
| `dub_video.py:1865-1870` | Xuất lại đọc `input_path` (tuyệt đối) từ file dự án rồi mở file đó. Mục 4 chỉ sửa `work_dir`/`out_dir`, nên sau khi chuyển, **mọi lần xuất lại sẽ lỗi "không thấy file nguồn"**. | Bước apply phải sửa cả `input_path` trong `project.json` **và** `work/meta.json` sang đường dẫn thật mới. |
| `store.mjs:104-122` `readDubJobs` + `dub/functions.mjs:24` `dubJobOf` | Ghép theo `meta.input_path` = `resolveDownload(rel)`. Một bên đường dẫn cũ, một bên đường dẫn mới thì trạng thái "đang dở x%" biến mất, và kết quả `dub_video` trả về `{}`. | Ghép theo `rel_path` logic: `relOf(meta.input_path)` ở cả hai phía, không so đường dẫn tuyệt đối. |
| `dub/routes.mjs:41`, `sources/service.mjs:113`, `:121` | Chặn lồng tiếng chính bản xuất bằng `startsWith(DUBBED_DIR)`. Ở bố cục mới bản xuất nằm trong `jobs/*/out/`, nên phép kiểm này không còn chặn được. | `resolveDownload` trả thêm loại file (`source` / `output`). Các chỗ này kiểm loại file, không so tiền tố thư mục. |
| `dub/functions.mjs:15-19` `dubResult` | Ghép cứng `DUBBED_DIR`, `DUB_PROJECTS_DIR`. | Hỏi lớp chỉ mục (8.5, commit 2). |
| `migrate.mjs:63-86` `migrateEdgeVoices` (chạy mỗi lần khởi động) | Chỉ quét `data/dub_work/*/meta.json`. | Quét thêm `data/videos/*/jobs/*/{project.json,work/meta.json}`. |
| `lib/tasks.mjs:131-136` | Chỉ nhận `SAVED_FILE` nằm trong `DOWNLOADS_DIR`. | Giữ nguyên. Không chuyển file **trong lúc** đang tải (xem dòng dưới). |
| `download_bilibili.mjs:320`, `:448-469`, `:607` | Bỏ qua nếu `downloads/bilibili/<tên>.mp4` đã có; `.part`/`.part.aria2` để tải tiếp. Nếu file đã bị chuyển đi thì **tải lại từ đầu**, ra bản trùng. | Không chuyển file `.part*`. Bản tải mới ở lại `downloads/` (đọc được cả hai bố cục) cho tới commit 9. Trước khi chạy script tải, server tra chỉ mục theo id nền tảng; đã có thì báo "đã tải", không gọi script. |
| `sources/repo.mjs:32-37` (xóa mục), xóa video nguồn | Đường dẫn xóa tính từ `DOWNLOADS_DIR`. | Xóa qua chỉ mục. Video còn job thì chỉ xóa `source/`, giữ `jobs/`. |

### 8.3 Lỗ hổng làm mất dữ liệu hoặc hỏng server đang chạy

1. **Server 3499 đang chạy trên chính `data/` thật.** Tiến trình pid 1021229 có `cwd` = repo, `PORT=3499`, và không đặt `REUP_DATA_DIR`/`REUP_MEDIA_ROOT`. Chỉ kiểm cổng 3456 thì script sẽ chuyển dữ liệu ngay dưới chân một server đang sống: job đang chạy ghi vào thư mục cũ, file JSON bị ghi đè. Script phải từ chối chạy nếu thấy một trong các dấu hiệu sau:
   - (a) có tiến trình đang mở `data/openreup.db`. better-sqlite3 giữ file mở suốt, nên cách này bắt được mọi server, bất kể cổng. Quét `/proc/*/fd`.
   - (b) có tiến trình `dub_video.py` hoặc `download_*.mjs` trong `/proc/*/cmdline`.
   - (c) có file khóa `data/.migrating`. Script tạo file này lúc bắt đầu và xóa khi xong. Server thấy file này lúc khởi động thì từ chối chạy.
   - Ngưỡng: bật lên là dừng, không có `--force` cho (a) và (b).
2. **Khác ổ đĩa.** Hiện `data/` và `downloads/` cùng ổ (`/dev/sda2`), nhưng script vẫn phải so `stat.dev` giữa nguồn và đích **trước khi rename tệp đầu tiên**. Khác ổ thì dừng, không tự chép rồi xóa.
3. **Sập giữa chừng.** `moves.jsonl` được ghi *trước* `rename`, nên dòng cuối có thể chưa thực hiện. Khi quay lui hoặc chạy lại: nếu `to` chưa có mà `from` còn thì bỏ qua dòng đó; nếu có cả `from` lẫn `to` thì dừng và báo. Mỗi job phải chuyển bằng **một** `rename` cả thư mục (`dub_work/<job>` → `jobs/<job>/work`) để không bao giờ bị nửa nọ nửa kia. File JSON ghi bằng `writeJson` (file tạm rồi `rename`). Thứ tự: chuyển media → sửa `project.json`/`meta.json` → sửa `dubbed.json` → ghi `video.json` cuối cùng. Server đọc theo từng file một (có ở chỗ mới thì đọc chỗ mới, không thì chỗ cũ), nên dừng ở bước nào cũng đọc được.
4. **Quay lui ghi đè việc làm sau khi chuyển.** Mục 4 bước 6 chép lại JSON **và DB** từ bản sao lưu: segment nào đã sửa sau khi chuyển sẽ mất.
   - Migrate không đụng DB, nên rollback **không** chép lại DB. Bản `VACUUM INTO` chỉ để cứu khi có sự cố.
   - Rollback phải từ chối nếu thấy dấu hiệu có việc làm sau khi chuyển: file JSON có mtime sau lúc kết thúc apply, có thư mục job hoặc bản xuất mới không có trong `moves.jsonl`, hoặc có file `video.json` lạ. Lúc đó liệt kê ra và dừng.
5. **`video_key` không tính lại được.** Hậu tố `-2` khiến khóa phụ thuộc thứ tự quét. Mọi chỗ tra cứu phải đi qua chỉ mục (`video.json`), không tự tính lại khóa. Bản tải mới phải tra theo id nền tảng trước khi tạo thư mục mới.
6. **Thư mục hệ thống.** `_orphan`, `_migration` bắt đầu bằng `_`, nên hàm tính khóa không bao giờ sinh ra được. Lúc liệt kê video phải bỏ qua `_*`.
7. **Chọn nguồn cho job, gom mồ côi.** Thứ tự tra:
   1. `meta.input_path`;
   2. `project.input_path` (ca `dub_qasandbox50_p1_0p5x` trỏ tới `BV1nHW3z3EhH_p1__.mp4`: phải gắn vào video đó, không cho vào `_orphan`);
   3. `title` trong `dubbed.json`;
   4. tên suy từ `job_id`.

   Không tra ra thì cho vào `_orphan`, và trong bản kế hoạch phải ghi lý do.
8. **So API trước/sau.** Ảnh chụp "trước" phải được lấy lúc dry-run/apply, *trước* khi chuyển, và lưu vào `_migration/`, để `--verify` so được.

Rủi ro thấp, chấp nhận: `media_cache.json`/`thumbs/` mất hiệu lực (tự tạo lại); `migrateVideoProjects` chỉ chạy khi chưa có file, không chạy lại.

### 8.4 `--job-id` của DevAI

Đúng hướng, nhưng không gấp: file nguồn giữ nguyên tên trong `source/`, nên `jobIdFor` vẫn ra đúng id cũ. Yêu cầu:

- kiểm tra theo đúng `safeJobId` (`^[0-9A-Za-z_-]+$`);
- nếu file dự án đã có mà `job_id` khác thì báo lỗi, không ghi đè;
- không có tham số thì giữ cách suy như cũ;
- phải merge **trước** commit 5.

### 8.5 Giai đoạn 2: các commit, theo thứ tự

Mỗi commit phải qua Reviewcode và Tester rồi mới làm commit tiếp. Không chạm 3499.

| # | Người làm | Commit | Điều kiện xong |
| --- | --- | --- | --- |
| 1 | DevBE | `lib/videos.mjs`: chỉ mục `video.json` (rel_path ↔ đường dẫn thật, job_id → `{project, work, out}`, loại file `source`/`output`), đọc cả hai bố cục; `config.mjs` thêm `VIDEOS_DIR = DATA_DIR/videos`; `resolveDownload`/`relOf` đi qua chỉ mục. | Chưa có `data/videos/` thì mọi test cũ vẫn xanh, snapshot API giữ nguyên. |
| 2 | DevBE | `store.mjs` (`dubWorkDirs`, `dubWorkDir` với điều kiện mới, load/save/remove), `dub/service.mjs` `pathArgs`, `dub/functions.mjs` `dubResult`, các chỗ kiểm `DUBBED_DIR` ở 8.2, `readDubJobs` ghép theo `rel_path`, `migrateEdgeVoices`. | Test có fixture ở cả hai bố cục; xóa job ở bố cục mới không xóa được ra ngoài `jobs/<job>/work`. |
| 3 | DevBE | Route `GET /downloads/*` thay cho `fastifyStatic`: Range, `Content-Type` của `.srt`, chặn `../`; `/api/dub/segments` chiếu 3 trường theo dạng cũ. | Test Range/206, `.srt`, chặn đường dẫn lạ; JSON `/api/dub/segments` giống từng byte. |
| 4 | DevAI | `dub_video.py --job-id` (8.4) + test Python; server truyền `--job-id`. | `pytest` xanh, id không đổi. |
| 5 | DevBE | `sources`: liệt kê từ `video.json` + bố cục cũ; `media.mjs` khóa cache theo `video_key`; xóa video qua chỉ mục. | `/api/sources` giống từng byte trên fixture. |
| 6 | DevBE | `scripts/migrate-video-folders.mjs` **chỉ dry-run** + test dựng lại các ca lệch ở 1.3. Sau đó chạy dry-run trên dữ liệu thật (chỉ đọc) và gửi bản kế hoạch cho Techlead/PM. | Techlead duyệt bản kế hoạch. |
| 7 | DevBE | `--apply`, `--verify`, `--rollback`, cùng mọi điều kiện ở 8.3 (khóa, quét `/proc`, so `stat.dev`, thứ tự ghi, rollback từ chối khi có việc mới) + test sập giữa chừng (cắt `moves.jsonl` ở dòng giữa). | Test: apply hai lần thì lần sau "0 việc"; rollback ra cây file giống hệt lúc đầu; sập giữa chừng rồi chạy lại vẫn ra kết quả đúng. |
| 8 | PM giao, DevBE chạy | Chuyển dữ liệu thật: PM xin chủ dự án tắt 3499 → `--apply` → `--verify` → bật lại. Không phải commit code; ghi lại log vào `_migration/`. | `--verify` xanh, 3499 bật lại chạy được. |
| 9 | DevBE | Bản tải mới được chuyển vào `data/videos/<key>/source/` khi tác vụ tải **kết thúc** (không chuyển giữa chừng); server tra chỉ mục theo id trước khi gọi script tải. | Tải lại một video đã có thì không tải trùng. |
| 10 | DevBE + DevAI + DevFE | Bỏ đường đọc bố cục cũ; đổi mặc định `WORK_ROOT`/`PROJECTS_DIR`/`DUB_OUT_DIR` của Python; DevFE sửa `web/app/help/page.tsx:12-14`. | Chỉ làm sau khi bước 8 đã chạy ổn ít nhất một vòng dùng thật. |

Ghi chú commit 3 (`ec9ca8e`): header của `/downloads/*` giữ nguyên cho mọi request hợp lệ (content-type, accept-ranges, Range → 206, 416, cache, etag, HEAD, 404). Có một thay đổi: đường dẫn chứa byte rỗng (`%00`, ví dụ `/downloads/bilibili/a%00.mp4`) trước trả **403** (thân 32 byte, từ `@fastify/static`), nay trả **404** như mọi đường dẫn không tra được. Symlink trong `downloads/` cũ trỏ ra ngoài cũng trả 404 thay vì được phục vụ.
