/**
 * Đọc/ghi dữ liệu của module ai: cache danh sách model dịch <REUP_DATA_DIR>/agy_models.json, và gọi `agy models` (Antigravity CLI).
 * Lệnh agy: biến AGY_BIN, không thì ~/.local/bin/agy, không thì "agy" trong PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../../config.mjs";
import { execFileP, readJson, writeJson } from "../../lib/util.mjs";

const CACHE = path.join(DATA_DIR, "agy_models.json");

const agyBin = () => {
  const local = path.join(os.homedir(), ".local", "bin", "agy");
  return process.env.AGY_BIN || (fs.existsSync(local) ? local : "agy");
};

export const aiRepo = {
  readModelCache: () => readJson(CACHE, null),
  writeModelCache: (cache) => writeJson(CACHE, cache),
  /** stdout của `agy models`; lỗi chạy lệnh (không có lệnh, quá giờ, mã thoát khác 0) ném nguyên lỗi của execFile. */
  async listAgyModels() {
    const { stdout } = await execFileP(agyBin(), ["models"], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return stdout;
  },
};
