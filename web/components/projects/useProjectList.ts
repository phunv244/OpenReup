"use client";
/** Lọc, tìm (không dấu) và sắp xếp danh sách dự án; kiểu hiển thị + sắp xếp nhớ trong localStorage. */
import { useEffect, useMemo, useState } from "react";
import { Project } from "@/lib/api";

export type View = "grid" | "list";
export type Filter = "all" | "dubbed" | "pending" | "empty";
export type Sort = "updated" | "name" | "videos";
const PREF_KEY = "reup.projects.view";

function usePrefs() {
  const [prefs, setPrefs] = useState<{ view: View; filter: Filter; sort: Sort }>({ view: "grid", filter: "all", sort: "updated" });
  useEffect(() => {
    try {
      // Chỉ khôi phục kiểu hiển thị và sắp xếp; bộ lọc luôn về "Tất cả" khi mở trang.
      const { view, sort } = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
      setPrefs((p) => ({ ...p, ...(view && { view }), ...(sort && { sort }) }));
    } catch {}
  }, []);
  const update = (patch: Partial<typeof prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      localStorage.setItem(PREF_KEY, JSON.stringify({ view: next.view, sort: next.sort }));
      return next;
    });
  return [prefs, update] as const;
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();

export function useProjectList(projects: Project[]) {
  const [prefs, setPrefs] = usePrefs();
  const [q, setQ] = useState("");
  const counts = useMemo(
    () => ({
      all: projects.length,
      dubbed: projects.filter((p) => (p.dubbed_count || 0) > 0).length,
      pending: projects.filter((p) => (p.pending_count || 0) > 0).length,
      empty: projects.filter((p) => !p.video_count).length,
    }),
    [projects],
  );
  const shown = useMemo(() => {
    const needle = norm(q.trim());
    const list = projects.filter((p) => {
      if (prefs.filter === "dubbed" && !p.dubbed_count) return false;
      if (prefs.filter === "pending" && !p.pending_count) return false;
      if (prefs.filter === "empty" && p.video_count) return false;
      return !needle || norm(`${p.name} ${p.type || ""}`).includes(needle);
    });
    const by: Record<Sort, (a: Project, b: Project) => number> = {
      updated: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
      name: (a, b) => a.name.localeCompare(b.name, "vi"),
      videos: (a, b) => (b.video_count || 0) - (a.video_count || 0),
    };
    return list.sort(by[prefs.sort]);
  }, [projects, prefs.filter, prefs.sort, q]);
  return { prefs, setPrefs, q, setQ, counts, shown };
}
