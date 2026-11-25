"use client";
import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { useProject, useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";

/** Dự án không tồn tại (đã xóa / gõ sai) thì quay về danh sách dự án. */
function Guard({ children }: { children: React.ReactNode }) {
  const id = useProjectId();
  const proj = useProject();
  const { loaded } = useStudio();
  const router = useRouter();
  useEffect(() => {
    if (loaded && !proj) router.replace("/");
  }, [loaded, proj, router]);
  if (!id || !proj) return null;
  return <>{children}</>;
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Guard>{children}</Guard>
    </Suspense>
  );
}
