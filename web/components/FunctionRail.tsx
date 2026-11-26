"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/api";
import { Icon } from "./Icon";
import { Resizer } from "./Resizer";
import { TaskCard } from "./TaskCard";
import { useToast } from "./Toasts";
import { copyText } from "./ui";

type Param = { type: string; description?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number; properties?: Record<string, Param> };
type Fn = { function: { name: string; description: string; parameters: { properties: Record<string, Param>; required?: string[] } } };

/** Giá trị mẫu để dán thử: mặc định / lựa chọn đầu tiên / theo kiểu. */
function sample(p: Param): unknown {
  if (p.default !== undefined) return p.default;
  if (p.enum) return p.enum[0];
  return p.type === "boolean" ? true : p.type === "number" ? (p.minimum ?? 1) : p.type === "object" ? {} : "";
}

function ParamRow({ name, p, required }: { name: string; p: Param; required: boolean }) {
  const range = p.minimum !== undefined || p.maximum !== undefined ? `${p.minimum ?? ""}…${p.maximum ?? ""}` : "";
  return (
    <li className="fn-param">
      <div className="fn-param-head">
        <code>{name}</code>
        <span className="fn-type">{p.type}</span>
        {required && <span className="badge red">bắt buộc</span>}
        {p.default !== undefined && <span className="fn-type">mặc định {String(p.default)}</span>}
        {range && <span className="fn-type">{range}</span>}
      </div>
      {p.description && <p>{p.description}</p>}
      {p.enum && <p className="fn-enum">{p.enum.map((v) => <code key={v}>{v}</code>)}</p>}
      {p.properties && (
        <ul className="fn-params nested">
          {Object.entries(p.properties).map(([k, v]) => (
            <ParamRow key={k} name={k} p={v} required={false} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Cột phải của trang Tài khoản AGY: các hàm AI gọi được (function calling / MCP / code mode) và tham số của từng hàm. */
export function FunctionRail() {
  const toast = useToast();
  const [fns, setFns] = useState<Fn[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    getJSON<{ functions?: Fn[]; error?: string }>("/api/functions")
      .then((d) => (d.functions ? setFns(d.functions) : setError("Server đang chạy bản cũ, chưa có /api/functions. Hãy khởi động lại (npm start).")))
      .catch((e) => setError(`Không tải được danh sách hàm: ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  const key = q.trim().toLowerCase();
  const shown = (fns || []).filter(({ function: f }) => !key || f.name.includes(key) || f.description.toLowerCase().includes(key));

  return (
    <aside className="rail" aria-label="Các hàm AI có thể gọi">
      <Resizer cssVar="rail-w" min={260} max={640} side="right" label="Kéo để đổi độ rộng cột bên phải" />
      <section className="rail-sec">
        <h4>Đang chạy</h4>
        <TaskCard variant="rail" />
      </section>
      <section className="rail-sec">
        <h4>
          Hàm AI có thể gọi {fns && <span className="badge gray">{fns.length}</span>}
        </h4>
        <p className="fn-lead muted">
          Dùng cho function calling, MCP và code mode. Gọi qua <code>POST /api/functions/call</code>; tác vụ dài chạy nền, lấy kết quả bằng{" "}
          <code>get_call</code>.
        </p>
        <input
          className="input input-sm"
          type="search"
          placeholder="Tìm hàm..."
          aria-label="Tìm hàm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {error && <p className="fn-lead" role="alert">{error}</p>}
        {!fns && !error && <p className="fn-lead muted">Đang tải...</p>}
        {fns && !shown.length && <p className="fn-lead muted">Không có hàm nào khớp.</p>}
        <div className="fn-list">
          {shown.map(({ function: f }) => {
            const props = Object.entries(f.parameters.properties);
            const required = f.parameters.required || [];
            const example = JSON.stringify(
              { name: f.name, arguments: Object.fromEntries(required.map((k) => [k, sample(f.parameters.properties[k])])) },
              null,
              2
            );
            return (
              <details className="fn" key={f.name}>
                <summary>
                  <Icon name="chevron" size={13} />
                  <code>{f.name}</code>
                  <span className="fn-count">{props.length ? `${props.length} tham số` : "không tham số"}</span>
                </summary>
                <div className="fn-body">
                  <p>{f.description}</p>
                  {props.length > 0 && (
                    <ul className="fn-params">
                      {props.map(([k, p]) => (
                        <ParamRow key={k} name={k} p={p} required={required.includes(k)} />
                      ))}
                    </ul>
                  )}
                  <div className="fn-example">
                    <span>Ví dụ gọi</span>
                    <button className="btn btn-light btn-sm" type="button" onClick={() => copyText(example, toast)}>
                      <Icon name="copy" size={12} /> Chép
                    </button>
                  </div>
                  <pre className="agy-out small">{example}</pre>
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
