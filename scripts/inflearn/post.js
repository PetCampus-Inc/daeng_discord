// Auto-post a project recruitment article to Inflearn community.
// Usage:
//   node scripts/inflearn/post.js
//   INFLEARN_CONFIG=../hola/config-b.js node scripts/inflearn/post.js
//   INFLEARN_DRY_RUN=1 node scripts/inflearn/post.js

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const STATE_PATH = path.join(__dirname, "state.json");
const CONFIG_REL = process.env.INFLEARN_CONFIG || "./config.js";
const CONFIG_PATH = path.isAbsolute(CONFIG_REL)
  ? CONFIG_REL
  : path.resolve(__dirname, CONFIG_REL);
const config = require(CONFIG_PATH);

const POST_URL = "https://www.inflearn.com/community/post/new?category=PROJECT";
const ART_DIR = "/tmp/inflearn-debug";
const headful = process.env.HEADFUL === "1";
const dryRun = process.env.INFLEARN_DRY_RUN === "1" || config.dryRun;
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

async function fillEditor(page, text) {
  const editor = page.locator(".tiptap.ProseMirror, [role='textbox'][contenteditable='true']").first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click();
  try {
    await editor.fill(text);
  } catch (_) {
    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    await page.keyboard.press(selectAll);
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(text);
  }
}

async function fillTags(page, tags) {
  if (!Array.isArray(tags) || !tags.length) return;
  const input = page.locator("input[aria-label='tag'], input[placeholder*='태그']").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  for (const tag of tags) {
    await input.fill(tag);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
  }
}

(async () => {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: !headful,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const ctx = await makeContext(browser);
  const page = await ctx.newPage();

  const responses = [];
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("inflearn.com")) {
      responses.push({ method: res.request().method(), status: res.status(), url });
    }
  });

  const res = await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);
  if (res && res.status() === 403) {
    await page.screenshot({ path: `${ART_DIR}/forbidden.png`, fullPage: true });
    console.error("Inflearn이 headless 브라우저 접근을 403으로 거부했습니다.");
    process.exit(4);
  }

  const titleInput = page.locator("textarea[aria-label='title'], textarea[placeholder*='제목']").first();
  await titleInput.waitFor({ state: "visible", timeout: 15000 });
  await titleInput.fill(config.title);

  await fillTags(page, config.tags || ["사이드프로젝트", "팀프로젝트", "프로젝트"]);
  await fillEditor(page, config.body);

  await page.screenshot({ path: `${ART_DIR}/before-submit.png`, fullPage: true });
  if (dryRun) {
    console.log("DRY RUN — 등록 안 함.");
    await ctx.storageState({ path: STATE_PATH }).catch(() => {});
    await browser.close();
    return;
  }

  const submit = page.getByRole("button", { name: "등록" }).last();
  await submit.click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${ART_DIR}/after-submit.png`, fullPage: true });

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/로그인|회원가입/.test(bodyText) && page.url().includes("/login")) {
    console.error("Inflearn 로그인 세션이 만료된 것 같습니다. scripts/inflearn/login.js 로 재로그인하세요.");
    process.exit(3);
  }

  console.log("\n=== Inflearn responses ===");
  for (const r of responses.slice(-30)) console.log(`${r.method} ${r.status} ${r.url}`);
  console.log("최종 URL:", page.url());
  console.log(`스크린샷: ${ART_DIR}/before-submit.png, ${ART_DIR}/after-submit.png`);

  await ctx.storageState({ path: STATE_PATH }).catch((e) => {
    console.warn("세션 저장 실패:", e.message);
  });
  await browser.close();
})().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
