"use client";
import { LogsBody } from "@/components/LogConsole";
import { Topbar } from "@/components/Shell";

export default function LogsPage() {
  return (
    <>
      <Topbar title="Nhật ký hệ thống" />
      <LogsBody />
    </>
  );
}
