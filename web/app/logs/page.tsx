"use client";
import { LogsBody } from "@/components/LogConsole";
import { Topbar } from "@/components/Shell";

export default function LogsPage() {
  return (
    <>
      <Topbar title="Nhật ký" sub="Tiến trình đang chạy và kết quả lần chạy gần nhất" />
      <LogsBody />
    </>
  );
}
