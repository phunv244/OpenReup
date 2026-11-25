import path from "node:path";
import type { NextConfig } from "next";

// Bản build: file tĩnh trong web/out, server Fastify phục vụ tại "/".
// Lúc dev (npm run dev, cổng 3000): chuyển /api và /downloads sang server Fastify ở cổng 3456.
const API = process.env.API_URL || "http://127.0.0.1:3456";
const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  // web/ là gói riêng (có package-lock.json riêng): đừng lấy thư mục cha làm gốc.
  turbopack: { root: path.resolve(__dirname) },
  trailingSlash: true,
  ...(isDev
    ? {
        // trailingSlash sẽ chuyển /api/x thành /api/x/ trước khi chuyển tiếp: tắt khi dev.
        skipTrailingSlashRedirect: true,
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${API}/api/:path*` },
            { source: "/downloads/:path*", destination: `${API}/downloads/:path*` },
          ];
        },
      }
    : { output: "export" }),
};

export default nextConfig;
