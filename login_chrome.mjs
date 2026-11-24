#!/usr/bin/env node
/**
 * Opens an isolated Google Chrome window backed by ./chrome_profile
 * so the user can log into Douyin and persist the session for list_channel_web.mjs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, "chrome_profile");
const URL =
  process.argv[2] ||
  "https://www.douyin.com/user/MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd";

async function main() {
  console.log(`[Login] Đang mở cửa sổ Chrome riêng với profile: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: "/usr/bin/google-chrome",
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  console.log("[Login] Cửa sổ Chrome đã sẵn sàng. Hãy đăng nhập Douyin, sau đó đóng cửa sổ Chrome để lưu phiên!");

  await new Promise((resolve) => context.on("close", resolve));
  console.log("[Login] Đã đóng Chrome và lưu phiên đăng nhập vào chrome_profile/.");
}

main().catch((err) => {
  console.error("[Login Error]", err.message);
  process.exit(1);
});
