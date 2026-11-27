/** Hàm /api/functions của module tasks: tác vụ nền đang chạy và nhật ký các lần gọi hàm. */
import { num, str } from "../../core/schema.mjs";
import { MAX_WAIT_SEC, getCall, listCalls, waitCall } from "../../lib/function-calls.mjs";
import { taskSnapshot } from "../../lib/tasks.mjs";

export const TASK_FUNCTIONS = [
  {
    name: "get_task",
    nolog: true,
    description: "Tác vụ nền đang chạy: loại, tiến độ %, hàng đợi, các dòng nhật ký gần nhất.",
    parameters: { log_lines: num("Số dòng nhật ký cuối cần lấy.", { default: 30 }) },
    run: async (a) => {
      const t = taskSnapshot();
      return { ...t, logs: t.logs.slice(-Math.max(0, Number(a.log_lines ?? 30))) };
    },
  },
  { name: "stop_task", description: "Dừng tác vụ nền đang chạy (tiến độ lồng tiếng đã lưu, chạy lại sẽ nối tiếp).", route: ["POST", "/api/task/stop"], parameters: {} },
  {
    name: "get_call",
    nolog: true,
    description: "Xem 1 lần gọi hàm: trạng thái (queued/running/done/error/stopped), kết quả kèm đường dẫn file, lỗi đầy đủ, file log.",
    parameters: { call_id: num("Mã lần gọi (call_id)."), wait_sec: num("Chờ tối đa bấy nhiêu giây cho tới khi xong rồi mới trả.", { maximum: MAX_WAIT_SEC }) },
    required: ["call_id"],
    run: async (a) => {
      await waitCall(Number(a.call_id), a.wait_sec);
      const c = getCall(Number(a.call_id));
      if (!c) throw new Error(`Không có lần gọi nào mang call_id=${a.call_id}.`);
      return c;
    },
  },
  {
    name: "list_calls",
    nolog: true,
    description: "Nhật ký các lần gọi hàm gần đây, mới nhất trước.",
    parameters: { limit: num("Số bản ghi.", { default: 20, maximum: 200 }), status: str("Lọc theo trạng thái.", { enum: ["queued", "running", "done", "error", "stopped"] }) },
    run: async (a) => ({ calls: listCalls(a) }),
  },
];
