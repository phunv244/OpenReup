"use client";
import { LogsBody } from "@/components/LogConsole";
import { Topbar } from "@/components/Shell";

export default function ProjectLogsPage() {
  return (
    <>
      <Topbar title="Nhật ký" />
      <LogsBody />
    </>
  );
}
