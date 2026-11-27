"use client";
/** Trang "Nhật ký hệ thống" đã bỏ: nhật ký nằm trong cột Tiến trình (nút trên thanh tiêu đề). Giữ route để link cũ về trang chủ, không 404. */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LogsRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/"), [router]);
  return null;
}
