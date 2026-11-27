"use client";
import { postJSON } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import { Seg } from "./timeline-math";

type Opts = {
  jobId: string;
  items: Seg[];
  sel: Seg | null;
  cur: number;
  edits: Record<string, string>;
  toast: (m: string, t?: "success" | "error") => void;
  onStructuralChange: (removedIds: number[], patch?: Record<string, string>) => void;
  clearSelection: () => void;
  reload: () => Promise<void>;
};

/** Cắt / ghép / xóa câu đang chọn — áp dụng ngay trên server, cần "Lưu & xuất lại" để thấy trên video. */
export function useSegmentOps({ jobId, items, sel, cur, edits, toast, onStructuralChange, clearSelection, reload }: Opts) {
  const canSplit = Boolean(sel && cur > sel.start + 0.05 && cur < sel.end - 0.05);
  const idxOfSel = sel ? items.findIndex((s) => s.id === sel.id) : -1;
  const canMergeNext = idxOfSel >= 0 && idxOfSel < items.length - 1;

  async function split() {
    if (!sel) return;
    const d = await postJSON("/api/dub/segment/split", { job_id: jobId, id: sel.id, at: cur });
    if (d.error) return toast(d.error, "error");
    onStructuralChange([]);
    toast("Đã cắt câu — câu sau để trống, gõ lại lời rồi Lưu & xuất lại.", "success");
    await reload();
  }

  async function mergeNext() {
    if (!sel || !canMergeNext) return;
    const nxt = items[idxOfSel + 1];
    const withId = nxt.id;
    const d = await postJSON("/api/dub/segment/merge", { job_id: jobId, id: sel.id, with_id: withId });
    if (d.error) return toast(d.error, "error");
    // Server ghép lời đã lưu của 2 câu; nếu một trong hai còn bản sửa chưa lưu thì gộp lại thành bản sửa của câu đã ghép,
    // để khi Lưu không câu nào bị mất lời (trước đây bản sửa câu 1 đè mất lời câu 2).
    const a = String(sel.id);
    const b = String(withId);
    const patch: Record<string, string> = {};
    if (a in edits || b in edits) {
      patch[a] = [a in edits ? edits[a] : sel.vi, b in edits ? edits[b] : nxt.vi].map((t) => t.trim()).filter(Boolean).join(" ");
    }
    onStructuralChange([withId], patch);
    toast("Đã ghép 2 câu.", "success");
    await reload();
  }

  async function remove() {
    if (!sel) return;
    if (!confirm(`Xóa câu ${fmtDur(sel.start)}? Chỉ xóa dòng lời, cần "Lưu & xuất lại" để video khớp lại.`)) return;
    const d = await postJSON("/api/dub/segment/delete", { job_id: jobId, id: sel.id });
    if (d.error) return toast(d.error, "error");
    onStructuralChange([sel.id]);
    clearSelection();
    toast("Đã xóa câu.", "success");
    await reload();
  }

  return { canSplit, canMergeNext, split, mergeNext, remove };
}
