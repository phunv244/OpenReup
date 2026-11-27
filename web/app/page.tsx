"use client";
/** Trang chủ: danh sách dự án Reup (lưới / danh sách, lọc, tìm, sắp xếp). */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { NewProjectModal } from "@/components/projects/NewProjectModal";
import { ProjectCard, ProjectRow } from "@/components/projects/ProjectCard";
import { Filter, Sort, View, useProjectList } from "@/components/projects/useProjectList";
import { Topbar } from "@/components/Shell";
import { Seg } from "@/components/ui";
import { projHref } from "@/lib/format";
import { useStudio } from "@/lib/studio";

export default function ProjectsPage() {
  const { projects, loaded } = useStudio();
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  // Link kiểu giao diện cũ (#/project/<id>/<trang>) vẫn mở đúng trang mới.
  useEffect(() => {
    const m = location.hash.match(/^#\/project\/([^/]+)(?:\/([a-z]+))?/);
    if (m) router.replace(projHref(decodeURIComponent(m[1]), ["douyin", "logs"].includes(m[2]) ? m[2] : "videos"));
    else if (/^#\/(models|logs|help)/.test(location.hash)) router.replace(`/${location.hash.slice(2).split("/")[0]}/`);
  }, [router]);
  const { prefs, setPrefs, q, setQ, counts, shown } = useProjectList(projects);

  return (
    <>
      <Topbar
        title="Reup"
        sub="Mỗi bộ truyện / phim một dự án Reup — AI nhớ nhân vật, xưng hô và mạch truyện"
        actions={
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> <span className="lbl">Tạo dự án</span>
          </button>
        }
      />
      <main className="content">
        {/* Chưa có dự án nào thì thanh tìm/lọc/sắp xếp không có tác dụng: chỉ còn thẻ "Tạo dự án mới". */}
        {projects.length > 0 && (
        <div className="pbar">
          <label className="pbar-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm dự án…"
              aria-label="Tìm dự án theo tên"
            />
          </label>
          <Seg<Filter>
            label="Lọc dự án"
            value={prefs.filter}
            onChange={(filter) => setPrefs({ filter })}
            items={(
              [
                { v: "all", label: "Tất cả", count: counts.all },
                { v: "dubbed", label: "Đã lồng tiếng", count: counts.dubbed, title: "Dự án có video đã lồng tiếng" },
                { v: "pending", label: "Chưa lồng", count: counts.pending, title: "Dự án còn video chưa lồng tiếng" },
                { v: "empty", label: "Trống", count: counts.empty, title: "Dự án chưa có video" },
              ] as const
            ).map((it) => ({ ...it, disabled: it.v !== "all" && !it.count && prefs.filter !== it.v }))}
          />
          <div className="pbar-right">
            <select className="select pbar-sort" aria-label="Sắp xếp" value={prefs.sort} onChange={(e) => setPrefs({ sort: e.target.value as Sort })}>
              <option value="updated">Mới cập nhật</option>
              <option value="name">Tên A→Z</option>
              <option value="videos">Nhiều video</option>
            </select>
            <Seg<View>
              label="Kiểu hiển thị"
              value={prefs.view}
              onChange={(view) => setPrefs({ view })}
              items={[
                { v: "grid", label: <Icon name="grid" size={15} />, title: "Dạng lưới" },
                { v: "list", label: <Icon name="list" size={15} />, title: "Dạng danh sách" },
              ]}
            />
          </div>
        </div>

        )}

        {shown.length === 0 && projects.length > 0 ? (
          <div className="pbar-empty">
            Không có dự án nào khớp.{" "}
            <button className="link-btn" type="button" onClick={() => { setQ(""); setPrefs({ filter: "all" }); }}>
              Xóa bộ lọc
            </button>
          </div>
        ) : prefs.view === "list" ? (
          <div className="plist" role="list">
            <div className="prow prow-head" aria-hidden="true">
              <span />
              <span>Dự án</span>
              <span className="prow-num">Video</span>
              <span className="prow-num">Đã lồng</span>
              <span className="prow-num">Chưa lồng</span>
              <span className="prow-date">Cập nhật</span>
              <span />
            </div>
            {shown.map((p) => (
              <div role="listitem" key={p.id}>
                <ProjectRow p={p} />
              </div>
            ))}
          </div>
        ) : (
          <div className="proj-grid">
            {shown.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
            {/* Thẻ "Tạo dự án mới" chỉ là trạng thái trống — khi đã có dự án thì dùng nút "Tạo dự án" trên thanh tiêu đề. */}
            {loaded && projects.length === 0 && (
            <button className="pcard pcard-new" type="button" onClick={() => setCreating(true)}>
              <span className="plus">
                <Icon name="plus" size={20} />
              </span>
              <b>Tạo dự án mới</b>
              <span>Mỗi bộ truyện / phim một dự án để AI nhớ nhân vật, xưng hô và mạch truyện</span>
            </button>
            )}
          </div>
        )}
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}
