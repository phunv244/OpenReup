#!/usr/bin/env node
import readline from "node:readline";
import {
  listAccounts,
  deleteAccount,
  clearAccountLocks,
  getActiveLocks,
  DATA_DIR,
} from "./src/store.mjs";
import {
  startOAuthSession,
  completeOAuthSessionManually,
  openBrowserBestEffort,
  ensureFreshToken,
} from "./src/oauth.mjs";
import { refreshAccountQuota } from "./src/quota.mjs";
import { routeChatCompletion } from "./src/router.mjs";

const args = process.argv.slice(2);
const cmd = args[0] || "help";

function getFlag(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

async function cmdLogin() {
  const customName = getFlag("--name", "");
  const session = await startOAuthSession({ customName });

  console.log("\n🔐 ĐĂNG NHẬP TÀI KHOẢN ANTIGRAVITY (GOOGLE OAUTH)");
  console.log("────────────────────────────────────────────────────────");
  const opened = openBrowserBestEffort(session.authUrl);
  if (opened) {
    console.log("Đã mở trình duyệt mặc định. Nếu chưa thấy, hãy mở đường dẫn sau:\n");
  } else {
    console.log("Hãy mở đường dẫn dưới đây trên trình duyệt của bạn:\n");
  }
  console.log(`  ${session.authUrl}\n`);
  console.log("• Nếu trình duyệt chạy trên CÙNG máy này: hệ thống sẽ tự bắt callback & lưu tự động.");
  console.log("• Nếu bạn đang SSH / chạy trên VPS: sau khi đăng nhập xong, copy toàn bộ URL");
  console.log(`  dạng http://localhost:${session.port}/callback?code=... dán thẳng vào đây rồi nhấn Enter:\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let finished = false;

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed || finished) return;
    try {
      console.log("⏳ Đang xác thực mã code & lấy Project ID...");
      const acc = await completeOAuthSessionManually(session.state, trimmed);
      finished = true;
      rl.close();
      console.log(`\n✅ Thành công! Đã lưu TK #${acc.priority}: ${acc.email || acc.name} (Project: ${acc.projectId || "auto"})`);
      process.exit(0);
    } catch (e) {
      console.error(`❌ ${e.message}\nHãy thử dán lại URL callback:`);
    }
  });

  try {
    const acc = await session.waitForCompletion();
    if (!finished) {
      finished = true;
      rl.close();
      console.log(`\n✅ Thành công! Đã lưu TK #${acc.priority}: ${acc.email || acc.name} (Project: ${acc.projectId || "auto"})`);
      process.exit(0);
    }
  } catch (err) {
    if (!finished) {
      finished = true;
      rl.close();
      console.error(`\n❌ Đăng nhập thất bại: ${err.message}`);
      process.exit(1);
    }
  }
}

function cmdList() {
  const accounts = listAccounts();
  console.log(`\n📋 DANH SÁCH TÀI KHOẢN ANTIGRAVITY (${accounts.length}) — Lưu tại: ${DATA_DIR}`);
  console.log("────────────────────────────────────────────────────────────────────────────");
  if (!accounts.length) {
    console.log("Chưa có tài khoản nào. Chạy `node cli.mjs login` để thêm tài khoản đầu tiên.\n");
    return;
  }
  for (const a of accounts) {
    const locks = Object.entries(getActiveLocks(a));
    const stateStr =
      a.isActive === false
        ? "⏸ ĐÃ TẮT"
        : locks.length > 0
          ? `⏳ COOLDOWN (${locks.map(([k, v]) => `${k} tới ${new Date(v).toLocaleTimeString()}`).join(", ")})`
          : "🟢 SẴN SÀNG";
    console.log(
      `#${a.priority} | ${a.id} | ${(a.email || a.name).padEnd(28)} | ${stateStr} | Reqs: ${a.totalRequests || 0} | Fallbacks: ${a.totalFallbacksFrom || 0}`
    );
  }
  console.log("");
}

async function cmdQuota() {
  const accounts = listAccounts();
  if (!accounts.length) {
    console.log("Chưa có tài khoản nào. Chạy `node cli.mjs login` trước.");
    return;
  }
  console.log("\n📊 ĐANG KIỂM TRA QUOTA TRỰC TIẾP TỪ ANTIGRAVITY...");
  console.log("────────────────────────────────────────────────────────────────────────────");
  for (const a of accounts) {
    try {
      const fresh = await ensureFreshToken(a);
      const q = await refreshAccountQuota(a.id, fresh.accessToken, fresh.projectId, { force: true });
      console.log(`\n▶ TK #${a.priority}: ${a.email || a.name} [Gói: ${q.plan || "Unknown"} | Project: ${q.projectId || fresh.projectId || "-"}]`);
      const entries = Object.entries(q.quotas || {});
      if (!entries.length) {
        console.log("   (Không có dữ liệu chi tiết bucket trả về — tài khoản vẫn có thể chat bình thường)");
        continue;
      }
      for (const [k, info] of entries) {
        if (typeof info?.remainingPercentage !== "number") continue;
        const pct = Math.round(info.remainingPercentage * 10) / 10;
        const reset = info.resetAt ? ` | Reset: ${new Date(info.resetAt).toLocaleString()}` : "";
        console.log(`   - ${(info.displayName || k).padEnd(28)}: còn ${String(pct).padStart(5)}%${reset}`);
      }
    } catch (e) {
      console.log(`\n▶ TK #${a.priority}: ${a.email || a.name} -> ❌ Lỗi: ${e.message}`);
    }
  }
  console.log("");
}

async function cmdUnlock() {
  const target = args[1] || "all";
  const accounts = listAccounts();
  if (target === "all") {
    for (const a of accounts) await clearAccountLocks(a.id);
    console.log(`✅ Đã xóa khóa cooldown cho toàn bộ ${accounts.length} tài khoản.`);
  } else {
    const found = accounts.find((a) => a.id === target || a.email === target || String(a.priority) === target);
    if (!found) {
      console.error(`Không tìm thấy tài khoản khớp với "${target}"`);
      process.exit(1);
    }
    await clearAccountLocks(found.id);
    console.log(`✅ Đã xóa khóa cooldown cho TK #${found.priority} (${found.email || found.id}).`);
  }
}

async function cmdRemove() {
  const target = args[1];
  if (!target) {
    console.error("Cách dùng: node cli.mjs remove <id|email|số_thứ_tự>");
    process.exit(1);
  }
  const found = listAccounts().find((a) => a.id === target || a.email === target || String(a.priority) === target);
  if (!found) {
    console.error(`Không tìm thấy tài khoản "${target}"`);
    process.exit(1);
  }
  await deleteAccount(found.id);
  console.log(`🗑 Đã xóa tài khoản ${found.email || found.id}`);
}

async function cmdAsk() {
  const model = getFlag("--model", undefined);
  const promptParts = args.slice(1).filter((a, i, arr) => a !== "--model" && arr[i - 1] !== "--model");
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error('Cách dùng: node cli.mjs ask "Câu hỏi của bạn" [--model gemini-3.8-flash]');
    process.exit(1);
  }

  const res = await routeChatCompletion({
    model,
    stream: false,
    messages: [{ role: "user", content: prompt }],
  });

  if (res.status !== 200) {
    console.error(`❌ Lỗi (${res.status}):`, res.json?.error?.message || res.json);
    process.exit(1);
  }

  const choice = res.json.choices?.[0]?.message || {};
  console.log(
    `\n✓ Xử lý bởi TK #${res.account?.priority} (${res.account?.email || res.account?.name}) | Model: ${res.json.model} | Fallback: ${res.fallbackCount || 0}\n`
  );
  if (choice.reasoning_content) {
    console.log("--- [Suy nghĩ] ---\n" + choice.reasoning_content.trim() + "\n------------------\n");
  }
  console.log(choice.content || "");
}

function printHelp() {
  console.log(`
AGY Multi-Account Proxy CLI
Cách dùng:
  node cli.mjs login [--name "Tên"]   Đăng nhập thêm tài khoản Antigravity bằng Google OAuth
  node cli.mjs list                   Xem danh sách các tài khoản & thứ tự ưu tiên
  node cli.mjs quota                  Kiểm tra trực tiếp % quota còn lại của từng tài khoản
  node cli.mjs unlock [all|id|email]  Mở khóa cooldown thủ công
  node cli.mjs remove <id|email|#stt> Xóa tài khoản
  node cli.mjs ask "Câu hỏi..."       Gọi thử qua bộ định tuyến đa tài khoản
  node server.mjs [--port 3457]       Khởi chạy HTTP API Proxy + Giao diện Web
`);
}

switch (cmd) {
  case "login":
  case "auth":
    await cmdLogin();
    break;
  case "list":
  case "ls":
  case "accounts":
    cmdList();
    break;
  case "quota":
    await cmdQuota();
    break;
  case "unlock":
    await cmdUnlock();
    break;
  case "remove":
  case "rm":
    await cmdRemove();
    break;
  case "ask":
    await cmdAsk();
    break;
  default:
    printHelp();
}
