# OpenReup Studio

Công cụ quản lý dự án Reup video đa nguồn (**Douyin**, **Bilibili**, **YouTube**), tự động xóa logo (`ffmpeg delogo`), và **Dịch + Lồng tiếng Việt tự động 100% bằng Antigravity AI (`agy`)** theo ngữ cảnh từng dự án Truyện / Phim.

## Tính năng chính
- **Quản lý theo Dự án Truyện / Phim:** Mỗi bộ truyện hoặc phim là 1 dự án riêng lưu bối cảnh, danh sách nhân vật, xưng hô, từ điển thuật ngữ và tóm tắt mạch truyện xuyên suốt nhiều tập.
- **Một trang "Video & Lồng tiếng" cho mọi việc:** thêm video từ Bilibili / YouTube (cắt theo khung giờ `00:00:00-01:00:00`, chọn Part `1-5`, xóa logo), xem thư viện, lồng tiếng, sửa lời và xuất lại.
- **Quét & tải video Douyin Web (Kho Douyin):** Mở Chrome lưu phiên đăng nhập (`chrome_profile/`), tự bắt API danh sách video kèm ảnh bìa, thời lượng, link MP4 gốc, tự phân tách Phần 1 / Phần 2.
- **Dịch & Lồng tiếng Việt tự động (`faster-whisper` + Antigravity `agy` + TTS):**
  - Làm chậm tạm âm thanh `0.5x` để tách thoại tiếng Trung nói nhanh → quy đổi mốc giờ chuẩn về **tốc độ gốc `1.0x`**.
  - Tự động gọi `agy` đọc ngữ cảnh dự án, sửa lỗi nghe nhầm, dịch tự nhiên, và tự bổ sung nhân vật/thuật ngữ/tóm tắt tập vào dự án.
  - Ghép giọng đọc tiếng Việt + hộp phụ đề nền đen che phụ đề gốc, kèm trình **Sửa lời & Xuất lại** trực tiếp trên web.

## Video rất dài (9 – 90 tiếng)
Toàn bộ pipeline được thiết kế để chạy nhiều ngày liên tục mà không tốn RAM và không sợ gián đoạn:

| Công đoạn | Cách xử lý | Lưu / cache ở |
|---|---|---|
| Tải video | `yt-dlp` + `aria2c` 16 kết nối (CDN Bilibili bóp mỗi kết nối ~1 MB/s), tự nối tiếp file `.part`, tự thử lại 5 lần, ước tính dung lượng và kiểm tra ổ cứng **trước** khi tải | `downloads/bilibili/` |
| Nhận diện | Giải mã từng khối ~10 phút (cắt tại khoảng lặng, không cắt đôi câu), mỗi khối xong là ghi checkpoint | `data/dub_work/<job>/chunks/` |
| Dịch | 3 lô chạy song song ngay khi khối vừa nhận diện xong; lỗi mạng thì thử lại, lô hỏng không làm mất cả video | cùng file khối |
| Giọng đọc | 12 luồng chạy nền, cache theo nội dung câu (câu trùng / câu không sửa không phải tạo lại) | `tts/` |
| Track tiếng | Dựng theo từng phần FLAC khớp timeline chính xác từng mẫu | `audio/` |
| Xuất video | Mã hóa theo từng phần 10 phút, cache theo nội dung phụ đề; trộn tiếng chạy song song | `parts/` |

- **Dừng / mất điện / mất mạng:** bấm **Tiếp tục** ở video đó, mọi công đoạn chạy tiếp từ chỗ đang dở.
- **Sửa 1 câu rồi xuất lại:** chỉ tạo lại giọng của câu đó và mã hóa lại đúng phần 10 phút chứa nó.
- **Nên chọn "Không xóa lúc tải"** rồi bật **Xóa logo khi xuất** ở bước lồng tiếng: video chỉ bị mã hóa một lần.
- **Ổ cứng:** cần trống ~2,2 lần dung lượng video nếu in phụ đề / xóa logo, ~1,2 lần nếu giữ nguyên hình. Lấy lại chỗ bằng **⋯ → Xóa cache**.
- **Thời gian (máy 8 nhân, không GPU):** nhận diện `base` ≈ 0,3 lần thời lượng video, `small` ≈ 0,8 lần; in phụ đề ≈ 0,3 lần. Video 90 tiếng với `base` + in phụ đề mất khoảng 2–3 ngày.

Kiểm tra nhanh phần lõi (không cần mạng): `.venv/bin/python test_dub_video.py`

## Cài đặt & Chạy

### Yêu cầu
- Node.js >= 20, Python >= 3.10
- `ffmpeg`, `ffprobe`, `yt-dlp`, Google Chrome, Antigravity CLI (`agy`)
- Nên có `aria2c` (`sudo apt install aria2`): tải Bilibili nhanh gấp ~10 lần. Không có vẫn chạy, tự dùng chế độ chia khúc.
- Tùy chọn: đặt `cookies.txt` (xuất từ trình duyệt đã đăng nhập Bilibili) ở thư mục gốc để tải 1080P cao / 4K.

### Cài đặt
```bash
# 1. Cài dependencies Node.js (dùng Chrome có sẵn trên máy)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# 2. Tạo Python venv cho Whisper & TTS
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper requests vieneu
```

### Mô hình nhận diện tiếng Trung
Mục **Mô hình nhận diện** (thanh trái, ngoài dự án) liệt kê các mô hình kèm ghi chú, mô hình chưa có thì có nút **Tải về**.
Danh mục nằm ở `asr.py` (`CATALOG`); mô hình sherpa-onnx lưu ở `data/asr_models/`, mô hình Whisper ở cache Hugging Face.
- **SenseVoice-Small** (mặc định): nhanh nhất trên CPU, có dấu câu. Đo trên video 8 phút: 31 giây, sót ~4% lời thoại
  (Whisper base: 145 giây, sót 21%; Whisper small: 464 giây, sót 22%).
- Whisper (medium, large-v3-turbo, BELLE large-v3-zh) tự chạy trên GPU NVIDIA khi có; FireRedASR chạy qua sherpa-onnx (CPU).
- Cần `uv pip install --python .venv/bin/python sherpa-onnx` cho SenseVoice / Paraformer / FireRedASR.
- **Bộ lọc giọng nói (VAD)** chọn ở cùng trang. Đo trên video 8 phút với SenseVoice: FireRedVAD 1178 chữ (khuyên dùng,
  cần PyTorch CPU ~760 MB), Silero 2 lượt 1072 chữ (nhẹ, không cần cài thêm), TEN VAD 933 chữ.

### Giọng đọc VieNeu-TTS (offline, clone giọng)
```bash
uv pip install --python .venv/bin/python vieneu   # bản CPU, không cần torch/GPU
```
- Chọn giọng `VieNeu · ...` (25 giọng có sẵn) hoặc giọng clone trong hộp thoại Lồng tiếng.
- **Mục "Giọng đọc" của dự án**: tick các giọng dự án dùng (giọng đầu là giọng chính), nghe thử bằng câu tự gõ,
  và **Clone giọng mới** từ file tải lên, link video hoặc video trong dự án. Máy tự chọn đoạn nói 3–8,5 giây sạch nhất,
  hoặc tự nhập mốc giây. Thư viện giọng dùng chung mọi dự án (`data/voices.json` + `data/voices/<ten>.wav`);
  file `.wav` thả tay vào `data/voices/` cũng được tự nhận.
- Có sẵn `data/voices/tuncoi.wav`: cắt từ video mẫu TunCoi Dub (giọng cao ~320 Hz, đọc nhanh ~4,2 tiếng/giây).
- **Mỗi nhân vật một giọng** (bật sẵn trong hộp thoại Lồng tiếng): sau khi dịch, máy nghe giọng gốc từng câu
  (bộ trích đặc trưng giọng của VieNeu) và gom thành NV1, NV2… NV1 (nói nhiều nhất) dùng giọng đã chọn, nhân vật khác
  tự nhận giọng VieNeu nam/nữ theo cao độ (> 185 Hz coi là nữ/trẻ em). Trong **Sửa lời**: đổi giọng từng nhân vật,
  đổi nhân vật của từng câu nếu máy tách nhầm, rồi **Lưu & xuất lại** (chỉ câu bị đổi mới phải đọc lại).
- Tốc độ trên CPU 4 nhân (Ryzen 5 2400G): ~1,5 giây máy cho 1 giây lời. Video 13 phút mất thêm ~10 phút;
  video vài chục tiếng nên chạy trên máy có GPU NVIDIA (`uv pip install "vieneu[cuda]"`, nhanh ~25 lần).

### Dữ liệu
- Câu thoại của các bản lồng tiếng nằm trong SQLite `data/openreup.db` (bảng `segments`), cần Node ≥ 22.13 (`node:sqlite`).
  File `data/dub_projects/<job>.json` chỉ còn thông tin chung. File đời cũ được tự chuyển lúc khởi động server,
  bản gốc giữ ở `data/dub_projects/_backup_json/`.

### Khởi chạy giao diện Web
```bash
npm --prefix web install          # lần đầu: cài thư viện giao diện
npm run build:web                 # build giao diện (chạy lại sau mỗi lần sửa web/)
DISPLAY=:0 node server.mjs        # hoặc: npm start
```
Mở trình duyệt tại **http://localhost:3456**.

### Cấu trúc code
- **Server (Fastify)**: `server.mjs` chỉ khởi động `server/index.mjs`. Mỗi nhóm API một file trong `server/routes/`
  (`tasks`, `sources`, `projects`, `voices`, `dub`); phần dùng chung trong `server/lib/` (hàng đợi tiến trình, SQLite,
  dữ liệu JSON, ảnh xem trước, giọng đọc). Thêm API mới: thêm `app.get/post(...)` vào file route tương ứng.
- **Giao diện (Next.js + React, thư mục `web/`)**: build thành file tĩnh (`web/out`), server Fastify phục vụ ở `/`.
  - `web/app/` — mỗi trang một thư mục: `/` Dự án, `/models`, `/logs`, `/help`, và trong dự án
    `/project/videos|douyin|voices|logs/?id=<dự án>`.
  - `web/components/` — khung trang, cột tiến trình, hộp thoại, bộ khoanh vùng logo; `components/video/` là các hộp thoại
    của trang Video (lồng tiếng, sửa lời, thêm video...).
  - `web/lib/studio.tsx` — dữ liệu dùng chung (dự án, video, giọng, mô hình, tiến trình); mọi trang đọc qua `useStudio()`.
- Sửa giao diện có tải lại tức thì: chạy 2 lệnh ở 2 terminal rồi mở **http://localhost:3000**
  ```bash
  npm run dev:api
  npm run dev:web
  ```
