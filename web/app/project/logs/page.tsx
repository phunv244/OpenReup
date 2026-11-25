"use client";
import { LogsBody } from "@/components/LogConsole";
import { ProjectTopbar } from "@/components/ProjectTopbar";

export default function ProjectLogsPage() {
  return (
    <>
      <ProjectTopbar title="Nhật ký" sub="Tiến trình đang chạy và kết quả lần chạy gần nhất" />
      <LogsBody />
    </>
  );
}
