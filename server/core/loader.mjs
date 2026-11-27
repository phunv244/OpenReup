/**
 * Nạp module của server theo phụ thuộc. Mỗi module là 1 object:
 *   { name, deps?: [tên module], init?(ctx) -> service, routes?(app, ctx), functions?: [định nghĩa hàm cho /api/functions] }
 * - Thứ tự nạp sắp theo deps; thiếu phụ thuộc, phụ thuộc vòng, trùng tên module/hàm -> lỗi ngay lúc khởi động.
 * - Module chỉ lấy service của module khác qua ctx.get(tên), và chỉ với tên đã khai trong deps.
 * - ctx.functions(): mọi hàm do các module khai, theo thứ tự nạp (module "functions" dùng để dựng /api/functions).
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Sắp module theo deps (giữ thứ tự khai báo khi không ràng buộc). Ném lỗi nếu khai sai. */
export function orderModules(mods) {
  const byName = new Map();
  for (const m of mods) {
    if (!m || typeof m.name !== "string" || !NAME_RE.test(m.name)) throw new Error(`Module không hợp lệ: name phải dạng "${NAME_RE.source}" (nhận ${JSON.stringify(m?.name)}).`);
    if (byName.has(m.name)) throw new Error(`Trùng tên module "${m.name}".`);
    for (const d of m.deps || []) if (!mods.some((x) => x?.name === d)) throw new Error(`Module "${m.name}" cần "${d}" nhưng "${d}" không có trong danh sách module.`);
    byName.set(m.name, m);
  }
  const out = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (m, chain) => {
    if (state.get(m.name) === "done") return;
    if (state.get(m.name) === "visiting") throw new Error(`Phụ thuộc vòng giữa các module: ${[...chain, m.name].join(" -> ")}.`);
    state.set(m.name, "visiting");
    for (const d of m.deps || []) visit(byName.get(d), [...chain, m.name]);
    state.set(m.name, "done");
    out.push(m);
  };
  for (const m of mods) visit(m, []);
  return out;
}

/** Khởi tạo service + đăng ký route của từng module lên app Fastify. Trả { services, functions }. */
export async function loadModules(app, mods) {
  const ordered = orderModules(mods);

  const functions = [];
  const owner = new Map();
  for (const m of ordered) {
    for (const f of m.functions || []) {
      if (owner.has(f.name)) throw new Error(`Hàm "${f.name}" khai ở cả module "${owner.get(f.name)}" và "${m.name}".`);
      owner.set(f.name, m.name);
      functions.push(f);
    }
  }

  const services = new Map();
  const ctxOf = (m) => ({
    get(name) {
      if (!(m.deps || []).includes(name)) throw new Error(`Module "${m.name}" gọi ctx.get("${name}") nhưng chưa khai "${name}" trong deps.`);
      return services.get(name);
    },
    functions: () => functions,
  });

  for (const m of ordered) {
    const ctx = ctxOf(m);
    services.set(m.name, m.init ? await m.init(ctx) : undefined);
    if (m.routes) await app.register(async (scoped) => m.routes(scoped, ctx));
  }
  return { services, functions };
}
