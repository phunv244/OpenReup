# OpenReup Studio

Công cụ quản lý dự án Reup video đa nguồn (**Douyin**, **Bilibili**, **YouTube**), tự động xóa logo (`ffmpeg delogo`), và **Dịch + Lồng tiếng Việt tự động 100% bằng Antigravity AI (`agy`)** theo ngữ cảnh từng dự án Truyện / Phim.

## Tính năng chính
- **Quản lý theo Dự án Truyện / Phim:** Mỗi bộ truyện hoặc phim là 1 dự án riêng lưu bối cảnh, danh sách nhân vật, xưng hô, từ điển thuật ngữ và tóm tắt mạch truyện xuyên suốt nhiều tập.
- **Quét & tải video Douyin Web:** Mở Chrome lưu phiên đăng nhập (`chrome_profile/`), tự bắt API danh sách video kèm ảnh bìa, thời lượng, link MP4 gốc, tự phân tách Phần 1 / Phần 2.
- **Tải video Bilibili / YouTube không logo (`yt-dlp` + `ffmpeg`):** Hỗ trợ cắt theo khung giờ (`00:00:00-01:00:00`), chọn Part (`1-5`), xóa logo góc trên trái/phải/2 góc, chống rớt mạng (`--continue`), kiểm tra dung lượng ổ đĩa.
- **Dịch & Lồng tiếng Việt tự động (`faster-whisper` + Antigravity `agy` + TTS):**
  - Làm chậm tạm âm thanh `0.5x` để tách thoại tiếng Trung nói nhanh → quy đổi mốc giờ chuẩn về **tốc độ gốc `1.0x`**.
  - Tự động gọi `agy` đọc ngữ cảnh dự án, sửa lỗi nghe nhầm, dịch tự nhiên, và tự bổ sung nhân vật/thuật ngữ/tóm tắt tập vào dự án.
  - Ghép giọng đọc tiếng Việt + hộp phụ đề nền đen che phụ đề gốc, kèm trình **Sửa lời & Xuất lại** trực tiếp trên web.

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
