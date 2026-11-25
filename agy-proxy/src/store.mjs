import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "./constants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.AGY_DATA_DIR || path.join(__dirname, "..", "data");
export const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const MODEL_LOCK_PREFIX = "modelLock_";
const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return structuredClone(fallback);
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

const DEFAULT_SETTINGS = {
  strategy: "fill-first", // "fill-first" (TK1 -> hết quota sang TK2) | "round-robin" (xoay vòng)
  stickyRoundRobinLimit: 1,
  defaultModel: DEFAULT_MODEL,
  requireApiKey: false,
  apiKey: "",
};

// Serialize state mutations so concurrent requests or CLI + Server updates never clobber
let writeQueue = Promise.resolve();
function withLock(fn) {
  const prev = writeQueue;
  let release;
  writeQueue = new Promise((r) => {
    release = r;
  });
  return prev.then(fn).finally(() => release());
}

export function getSettings() {
  const saved = readJsonSafe(SETTINGS_FILE, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function updateSettings(patch) {
  return withLock(() => {
    const cur = getSettings();
    const next = { ...cur };
    if (patch.strategy === "fill-first" || patch.strategy === "round-robin") {
      next.strategy = patch.strategy;
    }
    if (patch.stickyRoundRobinLimit !== undefined) {
      const n = Number(patch.stickyRoundRobinLimit);
      if (Number.isFinite(n) && n >= 1 && n <= 100) next.stickyRoundRobinLimit = Math.floor(n);
    }
    if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
      next.defaultModel = patch.defaultModel.trim();
    }
    if (typeof patch.requireApiKey === "boolean") {
      next.requireApiKey = patch.requireApiKey;
    }
    if (typeof patch.apiKey === "string") {
      next.apiKey = patch.apiKey.trim();
    }
    if (patch.regenerateApiKey === true) {
      next.apiKey = `sk-agy-${crypto.randomBytes(18).toString("base64url")}`;
    }
    writeJsonAtomic(SETTINGS_FILE, next);
    return next;
  });
}

export function listAccounts() {
  const data = readJsonSafe(ACCOUNTS_FILE, { accounts: [] });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  // Sort by priority ascending, then createdAt ascending (so Account 1 is always tried first in fill-first)
  return accounts.sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 999;
    const pb = Number.isFinite(b.priority) ? b.priority : 999;
    if (pa !== pb) return pa - pb;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

export function getAccountById(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

/**
 * Upsert an Antigravity OAuth account (deduped by email if available).
 */
export async function upsertAccount(accountData) {
  return withLock(() => {
    const accounts = listAccounts();
    const now = new Date().toISOString();
    const email = accountData.email?.trim()?.toLowerCase() || "";

    let existingIdx = -1;
    if (accountData.id) {
      existingIdx = accounts.findIndex((a) => a.id === accountData.id);
    }
    if (existingIdx === -1 && email) {
      existingIdx = accounts.findIndex((a) => (a.email || "").toLowerCase() === email);
    }

    const expiresAt = accountData.expiresAt
      || (accountData.expiresIn ? new Date(Date.now() + Number(accountData.expiresIn) * 1000).toISOString() : null);

    if (existingIdx >= 0) {
      const prev = accounts[existingIdx];
      const updated = {
        ...prev,
        name: accountData.name || prev.name || accountData.displayName || email || prev.id,
        email: accountData.email || prev.email || "",
        picture: accountData.picture || prev.picture || "",
        accessToken: accountData.accessToken || prev.accessToken,
        refreshToken: accountData.refreshToken || prev.refreshToken,
        expiresIn: accountData.expiresIn ?? prev.expiresIn ?? 3600,
        expiresAt: expiresAt || prev.expiresAt,
        scope: accountData.scope || prev.scope || "",
        projectId: accountData.projectId || prev.projectId || "",
        tierId: accountData.tierId || prev.tierId || "",
        isActive: accountData.isActive !== undefined ? Boolean(accountData.isActive) : (prev.isActive !== false),
        status: "active",
        lastError: null,
        errorCode: null,
        backoffLevel: 0,
        lastRefreshAt: now,
        updatedAt: now,
      };
      // Clear any previous locks on fresh login
      for (const k of Object.keys(updated)) {
        if (k.startsWith(MODEL_LOCK_PREFIX)) delete updated[k];
      }
      accounts[existingIdx] = updated;
      writeJsonAtomic(ACCOUNTS_FILE, { accounts });
      return updated;
    }

    const maxPriority = accounts.reduce((m, a) => Math.max(m, Number.isFinite(a.priority) ? a.priority : 0), 0);
    const created = {
      id: accountData.id || `agy_${crypto.randomBytes(6).toString("hex")}`,
      priority: maxPriority + 1,
      name: accountData.name || accountData.displayName || email || `Account #${accounts.length + 1}`,
      email: accountData.email || "",
      picture: accountData.picture || "",
      accessToken: accountData.accessToken,
      refreshToken: accountData.refreshToken || "",
      expiresIn: accountData.expiresIn || 3600,
      expiresAt,
      scope: accountData.scope || "",
      projectId: accountData.projectId || "",
      tierId: accountData.tierId || "",
      isActive: true,
      status: "active",
      backoffLevel: 0,
      consecutiveUseCount: 0,
      totalRequests: 0,
      totalFallbacksFrom: 0,
      lastUsedAt: null,
      lastRefreshAt: now,
      lastError: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    accounts.push(created);
    writeJsonAtomic(ACCOUNTS_FILE, { accounts });
    return created;
  });
}

export async function updateAccount(id, patch) {
  return withLock(() => {
    const accounts = listAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const next = { ...accounts[idx], ...patch, updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(next)) {
      if (k.startsWith(MODEL_LOCK_PREFIX) && v === null) {
        delete next[k];
      }
    }
    accounts[idx] = next;
    writeJsonAtomic(ACCOUNTS_FILE, { accounts });
    return next;
  });
}

export async function deleteAccount(id) {
  return withLock(() => {
    const accounts = listAccounts();
    const filtered = accounts.filter((a) => a.id !== id);
    if (filtered.length === accounts.length) return false;
    // Re-normalize priority 1..N
    filtered.forEach((a, i) => {
      a.priority = i + 1;
    });
    writeJsonAtomic(ACCOUNTS_FILE, { accounts: filtered });
    return true;
  });
}

export async function reorderAccounts(orderedIds) {
  return withLock(() => {
    const accounts = listAccounts();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const result = [];
    for (const id of orderedIds) {
      if (byId.has(id)) {
        result.push(byId.get(id));
        byId.delete(id);
      }
    }
    for (const rest of byId.values()) result.push(rest);
    result.forEach((a, i) => {
      a.priority = i + 1;
    });
    writeJsonAtomic(ACCOUNTS_FILE, { accounts: result });
    return result;
  });
}

// ─── Model Lock & Cooldown Helpers ────────────────────────────────────────────

export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

export function isModelLocked(account, model) {
  const now = Date.now();
  const specific = model ? account[getModelLockKey(model)] : null;
  const globalLock = account[MODEL_LOCK_ALL];
  if (specific && new Date(specific).getTime() > now) return true;
  if (globalLock && new Date(globalLock).getTime() > now) return true;
  return false;
}

export function getActiveLocks(account) {
  const now = Date.now();
  const locks = {};
  for (const [k, v] of Object.entries(account || {})) {
    if (!k.startsWith(MODEL_LOCK_PREFIX) || !v) continue;
    const ms = new Date(v).getTime();
    if (ms > now) {
      locks[k.slice(MODEL_LOCK_PREFIX.length)] = v;
    }
  }
  return locks;
}

export function getEarliestLockUntil(account, model = null) {
  const now = Date.now();
  let earliest = null;
  for (const [k, v] of Object.entries(account || {})) {
    if (!k.startsWith(MODEL_LOCK_PREFIX) || !v) continue;
    if (model && k !== getModelLockKey(model) && k !== MODEL_LOCK_ALL) continue;
    const ms = new Date(v).getTime();
    if (ms <= now) continue;
    if (!earliest || ms < earliest) earliest = ms;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

export async function clearAccountLocks(id, model = null) {
  const acc = getAccountById(id);
  if (!acc) return null;
  const now = Date.now();
  const patch = {};
  let remainingActive = 0;
  for (const [k, v] of Object.entries(acc)) {
    if (!k.startsWith(MODEL_LOCK_PREFIX)) continue;
    const ms = v ? new Date(v).getTime() : 0;
    if (!model || k === getModelLockKey(model) || k === MODEL_LOCK_ALL || ms <= now) {
      patch[k] = null;
    } else {
      remainingActive++;
    }
  }
  if (remainingActive === 0) {
    patch.status = "active";
    patch.lastError = null;
    patch.errorCode = null;
    patch.backoffLevel = 0;
  }
  return updateAccount(id, patch);
}

export function maskAccountForApi(acc, activeQuotas = null) {
  const locks = getActiveLocks(acc);
  return {
    id: acc.id,
    priority: acc.priority,
    name: acc.name,
    email: acc.email,
    picture: acc.picture || "",
    projectId: acc.projectId || "",
    tierId: acc.tierId || "",
    isActive: acc.isActive !== false,
    status: Object.keys(locks).length > 0 ? "cooldown" : (acc.status || "active"),
    locks,
    expiresAt: acc.expiresAt,
    totalRequests: acc.totalRequests || 0,
    totalFallbacksFrom: acc.totalFallbacksFrom || 0,
    lastUsedAt: acc.lastUsedAt,
    lastRefreshAt: acc.lastRefreshAt,
    lastError: acc.lastError,
    errorCode: acc.errorCode,
    createdAt: acc.createdAt,
    quotas: activeQuotas || null,
  };
}
