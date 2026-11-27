/**
 * OpenReup Studio — máy chủ web cục bộ (Fastify).
 * Phục vụ giao diện, API, hàng đợi tiến trình nền (quét / tải / xóa logo / lồng tiếng) và file video.
 */
import { API_TOKEN, HOST, LOCAL_ONLY, PORT } from "./config.mjs";
import { shutdownTasks } from "./lib/tasks.mjs";
import { buildApp } from "./app.mjs";

// Mở ra ngoài máy (LAN/Tailscale) mà không có token thì ai cũng sửa/xóa được dữ liệu: không cho khởi động.
if (!LOCAL_ONLY && !API_TOKEN) {
  console.error(`[Bảo mật] HOST=${HOST} mở server ra ngoài máy: phải đặt REUP_API_TOKEN (mọi request ghi gửi kèm "Authorization: Bearer <token>").`);
  process.exit(1);
}

const app = await buildApp();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shutdownTasks();
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
console.log(`OpenReup Studio đang chạy tại: http://localhost:${PORT}`);
