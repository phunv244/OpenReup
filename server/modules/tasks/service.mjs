/** Nghiệp vụ module tasks: thông tin máy (dung lượng ổ chứa repo). Tiến trình nền + hàng đợi nằm ở lib/tasks.mjs (dùng chung mọi module). */
import fs from "node:fs";

const gb = (blocks, bsize) => Number(((blocks * bsize) / 1024 ** 3).toFixed(1));

/** root: thư mục cần đo (ROOT của repo). Không đọc được ổ (statfs lỗi) thì trả 0/0 như trước. */
export function createTaskService(root) {
  return {
    disk() {
      try {
        const st = fs.statfsSync(root);
        return { free_gb: gb(st.bavail, st.bsize), total_gb: gb(st.blocks, st.bsize) };
      } catch {
        return { free_gb: 0, total_gb: 0 };
      }
    },
  };
}
