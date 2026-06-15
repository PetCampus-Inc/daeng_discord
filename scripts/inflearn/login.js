// First-run interactive login for Inflearn. Opens a real browser, lets you log in,
// then saves the session to scripts/inflearn/state.json when you press ENTER.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const STATE_PATH = path.join(__dirname, "state.json");
const INFLEARN_URL = "https://www.inflearn.com/community/post/new?category=PROJECT";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function newContext(browser) {
  const ctx = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  return ctx;
}

(async () => {
  fs.mkdirSync(__dirname, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto(INFLEARN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

  console.log("\n=========================================================");
  console.log("브라우저에서 Inflearn 로그인을 완료해주세요.");
  console.log("글쓰기 화면이 보이면 터미널에서 ENTER를 눌러 세션을 저장합니다.");
  console.log("취소하려면 Ctrl+C");
  console.log("=========================================================\n");

  await new Promise((resolve) => {
    process.stdin.setRawMode && process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });

  await ctx.storageState({ path: STATE_PATH });
  console.log(`세션 저장 → ${STATE_PATH}`);
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
