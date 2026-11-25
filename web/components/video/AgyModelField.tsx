"use client";
/** Chọn model Antigravity dùng để dịch + mức suy nghĩ. Nút làm mới hỏi lại `agy models` khi Antigravity đổi model. */
import { useEffect, useRef, useState } from "react";
import { AgyGroup, AgyModels, getJSON, postJSON } from "@/lib/api";
import { Icon } from "../Icon";
import { useToast } from "../Toasts";

const EFFORT_LABEL: Record<string, string> = {
  low: "Thấp — nhanh nhất",
  medium: "Vừa",
  high: "Cao",
  xhigh: "Rất cao — chậm",
  max: "Tối đa — rất chậm",
  "": "Mặc định",
};

export function AgyModelField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const toast = useToast();
  const [data, setData] = useState<AgyModels | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    getJSON<AgyModels>("/api/agy-models").then(setData).catch(() => setData({ ok: false, error: "Không đọc được danh sách model.", groups: [], models: [], fetched_at: "" }));
  }, []);

  async function refresh() {
    setBusy(true);
    const d = await postJSON<AgyModels>("/api/agy-models/refresh");
    setBusy(false);
    setData((old) => ({ ...(old || { models: [], fetched_at: "" }), ...d, groups: d.groups?.length ? d.groups : old?.groups || [] }) as AgyModels);
    if (!d.ok) return toast(d.error || "Không làm mới được danh sách model", "error");
    const parts = [
      d.added?.length ? `thêm ${d.added.length} model mới (${d.added.slice(0, 3).join(", ")}${d.added.length > 3 ? "…" : ""})` : "",
      d.removed?.length ? `${d.removed.length} model đã bị xóa (${d.removed.slice(0, 3).join(", ")}${d.removed.length > 3 ? "…" : ""})` : "",
    ].filter(Boolean);
    toast(parts.length ? `Đã làm mới: ${parts.join("; ")}` : `Đã làm mới: ${d.models.length} model, không có thay đổi`, "success");
  }

  const groups: AgyGroup[] = data?.groups || [];
  const current = groups.find((g) => g.efforts.some((e) => e.id === value));
  const missing = Boolean(value && data && !current); // model đã lưu nhưng Antigravity không còn
  const effort = current?.efforts.find((e) => e.id === value);

  function pickGroup(base: string) {
    if (!base) return onChange("");
    const g = groups.find((x) => x.base === base)!;
    onChange((g.efforts.find((e) => e.effort === "low") || g.efforts[0]).id);
  }

  return (
    <div className="field agy-field">
      <label htmlFor="mc-agy">Model dịch (Antigravity)</label>
      <div className="agy-row">
        <select id="mc-agy" className="select" value={missing ? "__missing" : current?.base || ""} onChange={(e) => pickGroup(e.target.value)} disabled={!data}>
          <option value="">Mặc định của Antigravity (suy nghĩ thấp)</option>
          {missing && <option value="__missing">{value} — không còn trong danh sách</option>}
          {groups.map((g) => (
            <option key={g.base} value={g.base}>
              {g.name}
            </option>
          ))}
        </select>
        {current && current.efforts.length > 0 && current.efforts[0].effort !== "" && (
          <select id="mc-agy-effort" className="select" aria-label="Mức suy nghĩ" value={effort?.id || ""} onChange={(e) => onChange(e.target.value)}>
            {current.efforts.map((e) => (
              <option key={e.id} value={e.id}>
                Suy nghĩ: {EFFORT_LABEL[e.effort] || e.effort}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-light btn-sm" type="button" onClick={refresh} disabled={busy} title="Hỏi lại Antigravity danh sách model hiện có">
          <Icon name="refresh" size={14} /> {busy ? "Đang làm mới…" : "Làm mới"}
        </button>
      </div>
      <div className="help">
        {missing ? (
          <>Model này đã bị Antigravity xóa — chạy sẽ báo lỗi. Hãy chọn model khác hoặc bấm <b>Làm mới</b>.</>
        ) : data?.ok === false ? (
          data.error
        ) : (
          <>
            Mức suy nghĩ càng cao thì dịch càng kỹ nhưng càng chậm (video dài có hàng trăm lô).
            {data?.fetched_at ? ` Danh sách cập nhật ${data.fetched_at.replace("T", " ")} · ${data.models.length} model.` : ""}
          </>
        )}
      </div>
    </div>
  );
}
