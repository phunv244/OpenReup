/** Model của Antigravity (`agy models`): có cache để mở hộp thoại không phải chờ, làm mới bằng tay khi Antigravity đổi model. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../config.mjs";
import { execFileP, readJson, writeJson } from "./util.mjs";

const CACHE = path.join(DATA_DIR, "agy_models.json");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_RE = new RegExp(`^(.+)-(${EFFORTS.join("|")})$`);

const agyBin = () => {
  const local = path.join(os.homedir(), ".local", "bin", "agy");
  return process.env.AGY_BIN || (fs.existsSync(local) ? local : "agy");
};

export const validAgyModel = (v) => /^[a-z0-9][a-z0-9.-]{0,63}$/.test(String(v));

/** "gemini-4-neon-high<TAB>Gemini 4 Neon (High)" -> [{id, name}] (bỏ dòng "Fetching..." và dòng lạ) */
export function parseAgyModels(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const [id, ...rest] = line.split("\t");
    if (rest.length && validAgyModel(id.trim())) out.push({ id: id.trim(), name: rest.join("\t").trim() });
  }
  return out;
}

/** Gom các bản cùng họ model nhưng khác mức suy nghĩ: gemini-4-neon-{low,medium,high,xhigh} -> 1 mục, nhiều mức. */
export function groupAgyModels(models) {
  const groups = new Map();
  for (const m of models) {
    const hit = EFFORT_RE.exec(m.id);
    const base = hit ? hit[1] : m.id;
    const g = groups.get(base) || { base, name: m.name.replace(/\s*\([^)]*\)\s*$/, ""), efforts: [] };
    if (hit) g.efforts.push({ effort: hit[2], id: m.id });
    else g.efforts.push({ effort: "", id: m.id }); // model không chia mức: dùng nguyên id
    groups.set(base, g);
  }
  for (const g of groups.values()) g.efforts.sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
  return [...groups.values()];
}

function view(cache, extra = {}) {
  return { ok: true, fetched_at: cache.fetched_at || "", models: cache.models || [], groups: groupAgyModels(cache.models || []), ...extra };
}

/** Danh sách model; refresh=true thì hỏi lại `agy models` (mất vài giây) và báo model mới / model đã bị xóa. */
export async function getAgyModels({ refresh = false } = {}) {
  const cache = readJson(CACHE, null);
  if (cache?.models?.length && !refresh) return view(cache);
  let stdout;
  try {
    ({ stdout } = await execFileP(agyBin(), ["models"], { timeout: 60_000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    const msg = err.code === "ENOENT" ? "Không tìm thấy lệnh agy (Antigravity CLI)." : `Không lấy được danh sách model: ${String(err.message).slice(0, 200)}`;
    return { ...view(cache || {}), ok: false, error: msg };
  }
  const models = parseAgyModels(stdout);
  if (!models.length) return { ...view(cache || {}), ok: false, error: "Antigravity không trả về model nào." };
  const old = new Set((cache?.models || []).map((m) => m.id));
  const now = new Set(models.map((m) => m.id));
  const fresh = { fetched_at: new Date().toISOString().slice(0, 19), models };
  writeJson(CACHE, fresh);
  return view(fresh, {
    added: cache ? models.filter((m) => !old.has(m.id)).map((m) => m.name) : [],
    removed: cache ? cache.models.filter((m) => !now.has(m.id)).map((m) => m.name) : [],
  });
}
