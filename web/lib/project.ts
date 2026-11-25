"use client";
/** Dự án đang mở: lấy từ ?id= trên đường dẫn (bản build tĩnh không có route động). */
import { useSearchParams } from "next/navigation";
import { useStudio } from "./studio";

export function useProjectId() {
  return useSearchParams().get("id") || "";
}

export function useProject() {
  const id = useProjectId();
  const { projects } = useStudio();
  return projects.find((p) => p.id === id) || null;
}
