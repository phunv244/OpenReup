# AGY Multi-Account Proxy — Thông tin & Hướng dẫn sử dụng

Bộ proxy độc lập trích xuất riêng phần kết nối **Antigravity** từ `9router` — chạy bằng **Node.js thuần (`>= 20`)**, **0 thư viện phụ thuộc ngoài** (không cần `npm install`).

---

## 1. Dự án này làm được gì?

- **Gom nhiều tài khoản Antigravity vào 1 API Endpoint duy nhất**:
  - Chuẩn OpenAI: `POST /v1/chat/completions`, `GET /v1/models` (hỗ trợ cả `stream: true` SSE, `stream: false` JSON, `tools`/function calling, ảnh base64/URL và `reasoning_content`).
  - Endpoint JSON rút gọn cho script/tool: `POST /v1/ask`.
- **Tự động Fallback khi hết Quota**:
  - Mặc định chạy chiến lược **Fill-First**: luôn ưu tiên **Tài khoản #1** → khi TK #1 dính `429`/`409` (hết quota) hoặc lỗi mạng/upstream, proxy tự đọc mốc `quotaResetTimeStamp` để tạm khóa TK #1 đúng thời gian reset và **lập tức chuyển tác vụ đó sang Tài khoản #2, #3...** trong cùng 1 request (client không bị rớt).
  - Hỗ trợ đổi sang chiến lược **Round-Robin** (xoay vòng đều) ngay trên giao diện Web.
- **Tự động gia hạn (Refresh) OAuth Token**: Tự làm mới token trước khi hết hạn 5 phút, chạy nền định kỳ mỗi 15 phút và tự retry khi gặp `401/403`.
- **Đăng nhập OAuth cực đơn giản** bằng cả **Giao diện Web** lẫn **CLI** (hỗ trợ cả máy cá nhân tự bắt callback lẫn máy VPS/SSH bằng cách dán URL callback).
- **Bảo vệ tài khoản thông minh**: Phân biệt lỗi `429` do hết quota thật với lỗi `429` do prompt chứa tên tool khác (tự động dời `systemInstruction` sang user turn để thử lại mà không khóa nhầm tài khoản).

---

## 2. Cấu trúc thư mục

```text
agy-proxy/
├── server.mjs          # HTTP Server API (/v1/*, /api/*) + Web Dashboard (mặc định cổng 3457)
├── cli.mjs             # Công cụ CLI (login, list, quota, unlock, remove, ask)
├── test.mjs            # Bộ test tự động 8 kịch bản (OAuth, dịch format, fallback 429, SSE)
├── package.json        # Các lệnh npm scripts tiện lợi
├── src/
│   ├── constants.mjs   # Cấu hình Antigravity OAuth, User-Agent, danh sách 45+ model
│   ├── store.mjs       # Lưu danh sách tài khoản & cấu hình tại data/accounts.json, data/settings.json
│   ├── oauth.mjs       # Luồng Google OAuth2 + loadCodeAssist/onboardUser + refresh token
│   ├── quota.mjs       # Kiểm tra live quota 5h & Tuần + circuit breaker chống spam 429
│   ├── translator.mjs  # Dịch hai chiều OpenAI ↔ Antigravity Cloud Code Envelope + SSE stream
│   ├── router.mjs      # Chọn tài khoản & tự động fallback khi hết quota/lỗi
│   └── ui.mjs          # Giao diện Web quản trị tiếng Việt
└── data/               # Tự động tạo khi chạy (lưu token OAuth — đã được gitignore)
```

---

## 3. Khởi chạy Server & Giao diện Web

```bash
cd /var/www/html/reupDouyin/agy-proxy

# Khởi động CHUNG 1 tiến trình duy nhất (OpenReup Studio + giao diện Tài khoản AGY + API /v1/* tại cổng 3456):
cd /var/www/html/reupDouyin && npm start
# → Giao diện quản lý AGY: http://localhost:3456/agy-proxy/
# → Endpoint API dùng chung: http://localhost:3456/v1/chat/completions và http://localhost:3456/v1/ask

# Hoặc chỉ chạy riêng AGY Proxy độc lập tại cổng 3457:
cd /var/www/html/reupDouyin/agy-proxy && npm start

# Hoặc chạy với cổng / host tùy chọn:
PORT=20128 HOST=0.0.0.0 node server.mjs
```

Mở trình duyệt tại **`http://localhost:3457`** để:
1. Bấm **"+ Đăng nhập OAuth Antigravity"** để thêm Tài khoản #1, Tài khoản #2, #3...
   - **Trên máy local**: cửa sổ đăng nhập Google mở ra → bấm Cho phép → tự động lưu & đóng tab.
   - **Trên VPS / truy cập từ xa**: sau khi đăng nhập Google, trình duyệt chuyển sang trang `http://localhost:xxxxx/callback?code=...` (báo lỗi kết nối) → copy toàn bộ URL trên thanh địa chỉ đó dán vào ô **Xác nhận thủ công** trong popup là xong.
2. Dùng nút **↑ / ↓** để đổi thứ tự ưu tiên tài khoản, bấm **Quota** để xem % còn lại (5h & Tuần), bấm **Mở khóa** để xóa cooldown thủ công, hoặc **Test gọi API** trực tiếp ngay trên trang.

---

## 4. Sử dụng qua CLI (không cần mở Web)

```bash
cd /var/www/html/reupDouyin/agy-proxy

# Đăng nhập thêm tài khoản bằng OAuth (hỗ trợ cả tự bắt callback lẫn dán URL trên SSH)
npm run login
# Hoặc đặt tên gợi nhớ:
node cli.mjs login --name "Tài khoản chính"

# Xem danh sách tài khoản, thứ tự ưu tiên & trạng thái khóa
npm run accounts

# Kiểm tra trực tiếp % quota 5h & Tuần của tất cả tài khoản
npm run quota

# Xóa khóa cooldown thủ công (tất cả hoặc 1 tài khoản cụ thể)
node cli.mjs unlock all
node cli.mjs unlock account1@gmail.com

# Xóa tài khoản khỏi Proxy
node cli.mjs remove account1@gmail.com

# Gọi thử 1 câu hỏi nhanh qua bộ định tuyến đa tài khoản
node cli.mjs ask "Dịch câu sau sang tiếng Việt: 一念永恒" --model gemini-3.8-flash

# Chạy bộ test tự động kiểm tra toàn bộ luồng hoạt động
npm test
```

---

## 5. Danh sách API Endpoints

### A. Endpoint dùng chung cho App / Script / SDK

| Method | Endpoint | Mô tả |
|---|---|---|
| `GET` | `/v1/models` | Danh sách 45+ model Antigravity (chuẩn OpenAI) |
| `POST` | `/v1/chat/completions` | Chat completions chuẩn OpenAI (hỗ trợ `stream: true/false`, `tools`, `image_url`, `reasoning_effort`) |
| `POST` | `/v1/ask` | Endpoint JSON rút gọn: gửi `{ prompt, system?, model?, json? }` → nhận `{ ok, text, reasoning, account, fallbackCount, usage }` |
| `GET` | `/api/health` | Kiểm tra trạng thái server & số tài khoản đang hoạt động |

### B. Endpoint quản trị (Web UI / Tự động hóa)

| Method | Endpoint | Mô tả |
|---|---|---|
| `GET` | `/api/accounts` | Lấy danh sách tài khoản, trạng thái cooldown & quota đã cache |
| `POST` | `/api/accounts/reorder` | Đổi thứ tự ưu tiên tài khoản (`{ "ids": ["id1", "id2"] }`) |
| `PATCH` | `/api/accounts/:id` | Bật/tắt (`{ "isActive": true/false }`) hoặc đổi tên |
| `POST` | `/api/accounts/:id/unlock` | Xóa khóa cooldown & cache hết quota của tài khoản |
| `DELETE` | `/api/accounts/:id` | Xóa tài khoản |
| `GET` | `/api/quota?force=1` | Làm mới live quota từ Google cho tất cả tài khoản |
| `POST` | `/api/oauth/start` | Khởi tạo phiên đăng nhập OAuth mới |
| `GET` | `/api/oauth/status?state=...` | Kiểm tra trạng thái đăng nhập OAuth |
| `POST` | `/api/oauth/manual` | Hoàn tất OAuth bằng URL callback dán thủ công (`{ state, callbackUrl }`) |
| `GET` / `POST` | `/api/settings` | Đọc / cập nhật chiến lược (`fill-first` / `round-robin`), model mặc định, API key |

### C. Headers hữu ích

- **Request headers tùy chọn**:
  - `Authorization: Bearer <API_KEY>` (chỉ cần khi bạn bật *"Yêu cầu API Key"* trong Cài đặt).
  - `X-AGY-Account-Id: <id hoặc email>` (ghim request vào 1 tài khoản cụ thể nếu muốn).
- **Response headers trả về trên mỗi lần gọi thành công**:
  - `X-AGY-Account-Email`: Email tài khoản thực sự xử lý request.
  - `X-AGY-Account-Priority`: Thứ tự ưu tiên của tài khoản đó (`1`, `2`, `3`...).
  - `X-AGY-Fallback-Count`: Số tài khoản đã bị bỏ qua do hết quota/lỗi (`0` = TK đầu tiên xử lý luôn; `1` = TK #1 hết quota nên đã tự nhảy sang TK #2).

---

## 6. Ví dụ code tích hợp

### cURL (Chuẩn OpenAI)
```bash
curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "system", "content": "Bạn là biên dịch viên chuyên nghiệp."},
      {"role": "user", "content": "Dịch sang tiếng Việt: 这一剑，破苍穹！"}
    ]
  }'
```

### Python (`requests` gọi `/v1/ask` siêu gọn)
```python
import requests

resp = requests.post("http://localhost:3457/v1/ask", json={
    "model": "gemini-3.8-flash",
    "system": "Trả lời ngắn gọn bằng tiếng Việt.",
    "prompt": "Tóm tắt nội dung câu: Nhất tiễn hạ song điêu",
    "json": False,  # Đặt True nếu muốn ép trả về JSON object
}, timeout=120).json()

print("Trả lời:", resp["text"])
print("Xử lý bởi:", resp["account"]["email"], "| Số lần fallback:", resp["fallbackCount"])
```

### Python (OpenAI SDK chính thức)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3457/v1",
    api_key="not-needed",  # Đổi thành key của bạn nếu đã bật requireApiKey
)

res = client.chat.completions.create(
    model="gemini-4-neon-medium",
    messages=[{"role": "user", "content": "Xin chào!"}],
)
print(res.choices[0].message.content)
```

---

## 7. Các model phổ biến hỗ trợ sẵn

- **Nhanh / Tiết kiệm quota (khuyên dùng cho dịch thuật hàng loạt)**: `gemini-3.8-flash`, `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high`, `gemini-3.7-flash-medium`
- **Gemini 4 cao cấp**: `gemini-4-neon-medium`, `gemini-4-neon-high`, `gemini-4-carbon-medium`, `gemini-4-carbon-high`, `gemini-4-hydrogen-high`, `gemini-4-argon-high`
- **Claude qua Antigravity**: `claude-sonnet-5-5`, `claude-sonnet-5-5-high`, `claude-opus-5-5`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`
- **Tạo ảnh**: `gemini-3.1-flash-image`

*(Có thể truyền trực tiếp tên model như `gemini-3.8-flash` hoặc kèm tiền tố `ag/gemini-3.8-flash` đều được tự nhận diện.)*

---

## 8. Biến môi trường tùy chọn

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3457` | Cổng HTTP server |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `AGY_DATA_DIR` | `./data` | Thư mục lưu `accounts.json` và `settings.json` |
