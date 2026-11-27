"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BatchTab } from "@/components/douyin/BatchTab";
import { ListTab } from "@/components/douyin/ListTab";
import { ScanTab } from "@/components/douyin/ScanTab";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { ProgressBar } from "@/components/TaskCard";
import { projHref, taskName } from "@/lib/format";
import { useProjectId } from "@/lib/project";
import { useStudio } from "@/lib/studio";

const TABS = [
  ["list", "Danh sách video", "Xem, lọc và đánh dấu trạng thái từng tập"],
  ["batch", "Tải theo tập", "Tải file MP4 gốc theo phần và khoảng tập"],
  ["scan", "Quét kênh", "Lấy danh sách video và link tải từ Douyin Web"],
] as const;

export default function DouyinPage() {
  const pid = useProjectId();
  const params = useSearchParams();
  const { task, loaded } = useStudio();
  const tab = TABS.find((t) => t[0] === params.get("tab")) || TABS[0];
  const busy = task?.running && (task.task_type === "scan_web" || task.task_type === "download");
  return (
    <>
      <Topbar title="Kho Douyin" sub={tab[2]} />
      <main className="content">
        <nav className="page-tabs" aria-label="Kho Douyin">
          {TABS.map(([k, label]) => (
            <Link key={k} href={projHref(pid, "douyin", `&tab=${k}`)} className={k === tab[0] ? "active" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        {busy && task && (
          <div className="inline-task">
            <b>
              <Icon name="download" size={16} /> {taskName(task.task_type)}
            </b>
            <ProgressBar task={task} />
          </div>
        )}
        {/* Chưa tải xong dữ liệu thì không hiện "chưa quét kênh" / danh sách rỗng sớm. */}
        {loaded && tab[0] === "list" && <ListTab pid={pid} />}
        {loaded && tab[0] === "batch" && <BatchTab pid={pid} />}
        {tab[0] === "scan" && <ScanTab />}
      </main>
    </>
  );
}
