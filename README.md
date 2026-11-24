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
| Tải video | `yt-dlp` tự nối tiếp file `.part`, tự thử lại 5 lần, ước tính dung lượng và kiểm tra ổ cứng **trước** khi tải | `downloads/bilibili/` |
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

### Cài đặt
```bash
# 1. Cài dependencies Node.js (dùng Chrome có sẵn trên máy)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# 2. Tạo Python venv cho Whisper & TTS
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper edge-tts requests
```

### Khởi chạy giao diện Web
```bash
DISPLAY=:0 node server.mjs
```
Mở trình duyệt tại **http://localhost:3456**.
