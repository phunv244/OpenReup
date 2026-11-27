"use client";
/** Thanh dưới cùng: tóm tắt thay đổi chưa lưu + mức làm lại, nút Hoàn tác và "Lưu & chạy lại". */
import { Icon } from "@/components/Icon";
import { PLAN_TEXT, type DubDetail } from "./useDubDetail";

export function DetailBar({ s }: { s: DubDetail }) {
  const { running, plan, summary, structural } = s;
  // Cắt/ghép/xóa câu đã ghi ngay vào DB: không tính là thứ hoàn tác được.
  const undoable = summary.length - (structural ? 1 : 0) > 0;
  return (
    <div className="detail-bar">
      <span className="detail-bar-text">
        {running ? (
          "Đang chạy lại..."
        ) : plan ? (
          <>
            <b>Đã {summary.join(", ") || "đổi"}:</b> {PLAN_TEXT[plan]}
          </>
        ) : (
          "Chưa có thay đổi nào."
        )}
      </span>
      <span className="grow" />
      <button
        className="btn btn-light"
        type="button"
        disabled={!undoable || running}
        onClick={s.reset}
        title="Bỏ các thay đổi chưa lưu (cắt/ghép/xóa câu đã áp dụng ngay, không hoàn tác được)"
      >
        Hoàn tác
      </button>
      <button className="btn btn-primary" type="button" disabled={!plan || running} onClick={s.save}>
        <Icon name="play" size={15} /> Lưu &amp; chạy lại
      </button>
    </div>
  );
}
