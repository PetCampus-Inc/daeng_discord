// Lightweight Inflearn session refresh. Opens the projects page with the saved
// browser state, verifies the account still looks logged in, then saves cookies,
// localStorage, and IndexedDB back to state.json.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const STATE_PATH = path.join(__dirname, "state.json");
const PING_URL = "https://www.inflearn.com/community/projects";
const ART_DIR = "/tmp/inflearn-ping-debug";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function makeContext(browser) {
  const opts = {
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  };
  if (fs.existsSync(STATE_PATH)) opts.storageState = STATE_PATH;
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  return ctx;
}

(async () => {
  if (!fs.existsSync(STATE_PATH)) {
    console.error("세션 파일이 없습니다. 먼저 'npm run inflearn:login' 으로 로그인하세요.");
    process.exit(2);
  }

  fs.mkdirSync(ART_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const ctx = await makeContext(browser);
  const page = await ctx.newPage();

  const res = await page.goto(PING_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${ART_DIR}/projects.png`, fullPage: true });

  if (res && res.status() === 403) {
    console.error("Inflearn이 headless 브라우저 접근을 403으로 거부했습니다.");
    await browser.close();
    process.exit(4);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const cookies = await ctx.cookies();
  const hasAuthCookie = cookies.some(
    (cookie) =>
      String(cookie.domain || "").includes("inflearn.com") &&
      ["connect.sid", "group_token"].includes(cookie.name)
  );
  const loginButtonVisible = await page
    .getByRole("link", { name: /^로그인$/ })
    .or(page.getByRole("button", { name: /^로그인$/ }))
    .first()
    .isVisible()
    .catch(() => false);
  const looksLoggedOut = /\/login/i.test(page.url()) || loginButtonVisible;

  if (!hasAuthCookie || looksLoggedOut) {
    console.error("Inflearn 로그인 세션이 만료된 것 같습니다. 'npm run inflearn:login' 후 재업로드하세요.");
    await browser.close();
    process.exit(3);
  }

  await ctx.storageState({ path: STATE_PATH, indexedDB: true });
  console.log("Inflearn 세션 ping 완료");
  await browser.close();
})().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
