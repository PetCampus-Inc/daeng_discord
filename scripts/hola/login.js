// First-run interactive login. Opens a real browser, clicks the 로그인 button,
// you finish the OAuth flow, then the script auto-detects auth and saves the
// session to scripts/hola/state.json. ENTER is also accepted as a manual save.

const { chromium } = require("playwright");
const path = require("path");

const STATE_PATH = path.join(__dirname, "state.json");

(async () => {
  // Hide the most obvious "automated browser" tells so Google OAuth lets us through.
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const ctx = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();

  // Watch for the auth-success signal so we can auto-save.
  let loggedIn = false;
  page.on("response", (res) => {
    const u = res.url();
    if (u.includes("api.holaworld.io/api/auth/token") && res.status() === 200) {
      loggedIn = true;
    }
  });

  await page.goto("https://holaworld.io", { waitUntil: "networkidle" });

  // Try to open the login modal/page automatically.
  try {
    await page.getByRole("button", { name: "로그인" }).first().click({ timeout: 3000 });
    console.log("로그인 버튼 클릭 — 카카오/구글 등으로 진행해주세요.");
  } catch (_) {
    try {
      await page.locator("text=로그인").first().click({ timeout: 3000 });
      console.log("로그인 링크 클릭 — 카카오/구글 등으로 진행해주세요.");
    } catch (__) {
      console.log("로그인 버튼이 안 보입니다. 브라우저에서 직접 눌러주세요.");
    }
  }

  console.log("\n=========================================================");
  console.log("브라우저 창에서 로그인을 완료해주세요.");
  console.log("완료되면 자동으로 세션을 저장합니다. (수동 저장은 터미널 ENTER)");
  console.log("취소하려면 Ctrl+C");
  console.log("=========================================================\n");

  // Wait until either: auth response observed, or user presses ENTER, or 10-min timeout.
  let manual = false;
  const stdinPromise = new Promise((resolve) => {
    process.stdin.setRawMode && process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once("data", () => {
      manual = true;
      resolve();
    });
  });
  const authPromise = (async () => {
    const start = Date.now();
    while (Date.now() - start < 10 * 60 * 1000) {
      if (loggedIn) return;
      await page.waitForTimeout(1500);
    }
    throw new Error("10분 안에 로그인이 감지되지 않았어요.");
  })();
  try {
    await Promise.race([authPromise, stdinPromise]);
  } catch (e) {
    console.error(e.message);
    await browser.close();
    process.exit(4);
  }

  // Give cookies a beat to settle if the auth call just landed.
  await page.waitForTimeout(800);
  await ctx.storageState({ path: STATE_PATH });
  console.log(`\n${manual ? "수동" : "자동"} 저장 → ${STATE_PATH}`);
  console.log("이제 'npm run hola:post:dry' 로 시험 실행 가능합니다.");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
