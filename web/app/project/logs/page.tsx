"use client";
/** Mục "Nhật ký" của dự án đã bỏ: nhật ký nằm trong cột Tiến trình (nút trên thanh tiêu đề). Giữ route để link cũ về trang chủ, không 404. */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ProjectLogsRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/"), [router]);
  return null;
}
