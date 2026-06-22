// Auto-post a project recruitment article to holaworld.io using a saved session.
// Usage:
//   node scripts/hola/post.js                       # headless, submit (config.js)
//   HOLA_CONFIG=config-b.js node scripts/hola/post.js # use a different config
//   HOLA_DRY_RUN=1 node scripts/hola/post.js        # fill fields but don't submit
//   HOLA_SKIP_DUPLICATE_DELETE=1 node scripts/hola/post.js # don't delete matching old posts
//   HEADFUL=1 node scripts/hola/post.js             # show the browser

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const STATE_PATH = path.join(__dirname, "state.json");
const CONFIG_REL = process.env.HOLA_CONFIG || "./config.js";
const CONFIG_PATH = path.isAbsolute(CONFIG_REL)
  ? CONFIG_REL
  : path.resolve(__dirname, CONFIG_REL);
console.log(`[config] ${CONFIG_PATH}`);
const config = require(CONFIG_PATH);

const REGISTER_URL = "https://holaworld.io/register";
const MY_POSTS_URL = "https://holaworld.io/myPosts";
const headful = process.env.HEADFUL === "1";
const skipDuplicateDelete = process.env.HOLA_SKIP_DUPLICATE_DELETE === "1";

(async () => {
  if (!fs.existsSync(STATE_PATH)) {
    console.error("세션 파일이 없습니다. 먼저 'node scripts/hola/login.js' 를 실행해주세요.");
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({
    storageState: STATE_PATH,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  const apiCalls = [];
  page.on("response", (res) => {
    const url = res.url();
    if (url.startsWith("https://api.holaworld.io/")) {
      apiCalls.push({ method: res.request().method(), status: res.status(), url });
    }
  });

  await page.goto(REGISTER_URL, { waitUntil: "networkidle", timeout: 45000 });
  // Detect logged-out state: a "로그인" submit button is the giveaway.
  const visibleLogin = await page.getByRole("button", { name: "로그인" }).first().isVisible().catch(() => false);
  if (visibleLogin) {
    console.error("로그인 세션이 만료된 것 같아요. 'node scripts/hola/login.js' 로 다시 로그인 후 시도해주세요.");
    await browser.close();
    process.exit(3);
  }

  // ---------- helpers ----------
  function normalizeText(text) {
    return String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  async function isLoggedOut() {
    return page.getByRole("button", { name: "로그인" }).first().isVisible().catch(() => false);
  }

  async function expandMyPostsList() {
    for (let i = 0; i < 8; i++) {
      const before = await page.locator("a").count().catch(() => 0);
      const moreBtn = page
        .getByRole("button", { name: /더\s*보기|더보기|More/i })
        .first();
      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(1000);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
      }
      const after = await page.locator("a").count().catch(() => 0);
      if (after === before && !(await moreBtn.isVisible().catch(() => false))) break;
    }
  }

  async function findDuplicatePostLinks() {
    const targetTitle = normalizeText(config.title);
    return page.evaluate((title) => {
      const normalize = (text) => String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
      const candidates = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        const text = normalize(anchor.innerText || anchor.textContent);
        if (text !== title && !text.includes(title)) continue;
        candidates.push({
          href: anchor.href,
          title: text,
        });
      }
      return Array.from(new Map(candidates.map((item) => [item.href, item])).values());
    }, targetTitle);
  }

  async function clickConfirming(action) {
    page.once("dialog", async (dialog) => {
      console.log(`  확인창: ${dialog.message()}`);
      await dialog.accept();
    });
    await action();
  }

  async function deletePostFromDetail(postUrl, index, dryRun = false) {
    console.log(`→ 중복 글 #${index} 상세 확인: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "networkidle", timeout: 45000 });

    const detailTitle = normalizeText(
      await page.locator("body").innerText({ timeout: 10000 }).catch(() => "")
    );
    if (!detailTitle.includes(normalizeText(config.title))) {
      console.warn("  제목이 상세 페이지에서 다시 확인되지 않아 삭제를 건너뜁니다.");
      return false;
    }

    if (config.contactValue && !detailTitle.includes(normalizeText(config.contactValue))) {
      console.warn("  연락처 URL이 상세 페이지에서 확인되지 않아 삭제를 건너뜁니다.");
      return false;
    }

    const deleteButton = page
      .getByRole("button", { name: /삭제|Delete/i })
      .or(page.getByText(/^삭제$/))
      .first();
    if (!(await deleteButton.isVisible().catch(() => false))) {
      console.warn("  삭제 버튼을 찾지 못해 건너뜁니다.");
      return false;
    }

    if (dryRun) {
      console.log("  DRY RUN 삭제 가능: 제목/연락처/삭제 버튼 확인됨");
      return true;
    }

    await clickConfirming(async () => {
      await deleteButton.click();
    });

    const confirmButton = page
      .getByRole("button", { name: /확인|삭제|예|네|OK|Delete/i })
      .first();
    if (await confirmButton.isVisible().catch(() => false)) {
      await clickConfirming(async () => {
        await confirmButton.click();
      });
    }

    await page.waitForTimeout(1500);
    console.log("  삭제 요청 완료");
    return true;
  }

  async function deleteDuplicatePosts() {
    if (skipDuplicateDelete) {
      console.log("→ 중복 글 삭제 건너뜀 (HOLA_SKIP_DUPLICATE_DELETE=1)");
      return;
    }

    console.log("→ 내 게시글에서 중복 제목 확인");
    await page.goto(MY_POSTS_URL, { waitUntil: "networkidle", timeout: 45000 });
    if (await isLoggedOut()) {
      console.error("로그인 세션이 만료된 것 같아요. 'node scripts/hola/login.js' 로 다시 로그인 후 시도해주세요.");
      await browser.close();
      process.exit(3);
    }

    await expandMyPostsList();
    const duplicates = await findDuplicatePostLinks();
    console.log(`→ 중복 후보 ${duplicates.length}개`);

    if (config.dryRun) {
      let verified = 0;
      for (let i = 0; i < duplicates.length; i++) {
        console.log(`  DRY RUN 삭제 대상: ${duplicates[i].href}`);
        try {
          if (await deletePostFromDetail(duplicates[i].href, i + 1, true)) verified++;
        } catch (e) {
          console.warn(`  DRY RUN 상세 확인 실패, 계속 진행: ${e.message}`);
        }
      }
      console.log(`→ DRY RUN 중복 글 검증 완료: ${verified}/${duplicates.length}`);
      return;
    }

    let deleted = 0;
    for (let i = 0; i < duplicates.length; i++) {
      try {
        if (await deletePostFromDetail(duplicates[i].href, i + 1)) deleted++;
      } catch (e) {
        console.warn(`  중복 글 #${i + 1} 삭제 실패, 새 글 등록은 계속 진행: ${e.message}`);
      }
    }
    console.log(`→ 중복 글 삭제 완료: ${deleted}/${duplicates.length}`);
  }

  // Find the combobox associated with a given label text.
  async function openCombobox(labelText) {
    const label = page.locator("label", { hasText: labelText }).first();
    const fieldGroup = label.locator("xpath=..");
    const combo = fieldGroup.locator("[role='combobox']").first();
    await combo.click();
    // Make sure focus is on the input so subsequent typing filters the list.
    await combo.focus();
    return combo;
  }
  // Try to click an option by visible text. If nothing matching is showing yet
  // (common in tech-stack lists), type the value to filter and try again.
  async function pickOption(combo, optionText) {
    const exact = page.getByRole("option", { name: optionText, exact: true }).first();
    try {
      await exact.waitFor({ state: "visible", timeout: 1200 });
      await exact.click();
      return;
    } catch (_) {}
    // Fallback: type-to-filter
    await combo.focus();
    await page.keyboard.type(optionText, { delay: 25 });
    await page.waitForTimeout(300);
    // Prefer exact match, then any option containing the text.
    const exact2 = page.getByRole("option", { name: optionText, exact: true }).first();
    const fuzzy = page.locator("[role='option']").filter({ hasText: optionText }).first();
    try {
      await exact2.waitFor({ state: "visible", timeout: 2500 });
      await exact2.click();
      return;
    } catch (_) {}
    await fuzzy.waitFor({ state: "visible", timeout: 2500 });
    await fuzzy.click();
  }
  async function selectSingle(labelText, value) {
    const combo = await openCombobox(labelText);
    await pickOption(combo, value);
  }
  async function selectMulti(labelText, values) {
    for (const v of values) {
      const combo = await openCombobox(labelText);
      await pickOption(combo, v);
      await page.waitForTimeout(150); // let react-select settle between picks
    }
  }
  // The contact-value input's placeholder changes based on the picked contact type:
  //   오픈톡 → "오픈 카톡방 링크" / 이메일 → "이메일" / 구글 폼 → "구글 폼 주소"
  // Match all three so any choice works.
  async function fillContactValue(value) {
    const input = page
      .locator(
        "input[placeholder*='오픈 카톡방 링크'], input[placeholder*='이메일'], input[placeholder*='구글 폼']"
      )
      .first();
    await input.waitFor({ state: "visible", timeout: 5000 });
    await input.fill(value);
  }
  async function fillQuill(text) {
    const editor = page.locator(".ql-editor").first();
    await editor.waitFor({ state: "visible", timeout: 10000 });
    await editor.click();
    // Clear existing content reliably.
    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    await page.keyboard.press(selectAll);
    await page.keyboard.press("Delete");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 2 });
      if (i < lines.length - 1) await page.keyboard.press("Enter");
    }
  }

  try {
    await deleteDuplicatePosts();
  } catch (e) {
    console.warn(`→ 중복 글 삭제 단계 실패, 새 글 등록은 계속 진행: ${e.message}`);
  }

  await page.goto(REGISTER_URL, { waitUntil: "networkidle", timeout: 45000 });

  console.log("→ 모집 구분");
  await selectSingle("모집 구분", config.type);

  console.log("→ 모집 인원");
  await selectSingle("모집 인원", config.recruitCount);

  console.log("→ 진행 방식");
  await selectSingle("진행 방식", config.mode);

  console.log("→ 진행 기간");
  await selectSingle("진행 기간", config.period);

  // 시작 예정 — 사이트가 필수로 강제하므로 빈 값이면 오늘 날짜로 자동 채움.
  {
    const todayKST = () => {
      const k = new Date(Date.now() + 9 * 60 * 60 * 1000);
      return k.toISOString().slice(0, 10);
    };
    const dateValue = config.startDate || todayKST();
    console.log(`→ 시작 예정 ${dateValue}`);
    const dateInput = page.locator("input[placeholder='YYYY-MM-DD']").first();
    await dateInput.click();
    await dateInput.fill("");
    await dateInput.type(dateValue);
    await page.keyboard.press("Tab");
  }

  if (config.skills && config.skills.length) {
    console.log(`→ 기술 스택 ${config.skills.length}개`);
    await selectMulti("기술 스택", config.skills);
  }

  if (config.positions && config.positions.length) {
    console.log(`→ 모집 포지션 ${config.positions.length}개`);
    await selectMulti("모집 포지션", config.positions);
  }

  if (config.contactType) {
    console.log("→ 연락 방법 타입");
    await selectSingle("연락 방법", config.contactType);
  }
  if (config.contactValue) {
    console.log("→ 연락 방법 값");
    await fillContactValue(config.contactValue);
  }

  console.log("→ 제목");
  const titleInput = page.locator("input[placeholder='글 제목을 입력해주세요!']");
  await titleInput.fill(config.title);

  console.log("→ 본문");
  await fillQuill(config.body);

  if (config.dryRun) {
    console.log("DRY RUN — 등록 안 함. 5초 후 종료.");
    await page.waitForTimeout(5000);
    await browser.close();
    return;
  }

  // Diagnostic snapshot right before submitting.
  const ART_DIR = "/tmp/hola-debug";
  try { fs.mkdirSync(ART_DIR, { recursive: true }); } catch (_) {}
  await page.screenshot({ path: `${ART_DIR}/before-submit.png`, fullPage: true });

  // Inspect the 등록하기 button state.
  const submitBtn = page.getByRole("button", { name: "등록하기" });
  const submitDisabled = await submitBtn.first().evaluate((el) => el.disabled || el.getAttribute("aria-disabled") === "true").catch(() => null);
  console.log(`→ 등록하기 disabled?`, submitDisabled);

  console.log("→ 등록하기 클릭");
  await submitBtn.first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${ART_DIR}/after-submit.png`, fullPage: true });

  // Capture any visible toast / inline error message.
  const errors = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(
      "[class*='toast'],[class*='Toast'],[class*='error'],[class*='Error'],[role='alert'],[class*='helper'],[class*='Helper']"
    ).forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t && t.length < 200) out.push(t);
    });
    return [...new Set(out)];
  });
  if (errors.length) console.log("⚠️ 에러/토스트 텍스트:", errors);

  // Wait for either navigation to the new post or fall through.
  try {
    await page.waitForURL(/\/study\/|\/hola-it\//, { timeout: 10000 });
  } catch (_) {}

  console.log("\n=== API calls during this run ===");
  for (const c of apiCalls) console.log(`  ${c.method} ${c.status} ${c.url}`);
  console.log("최종 URL:", page.url());
  console.log(`스크린샷: ${ART_DIR}/before-submit.png, ${ART_DIR}/after-submit.png`);

  // Persist the refreshed cookie jar so the session never goes stale between runs.
  try {
    await ctx.storageState({ path: STATE_PATH });
    console.log("세션 상태 저장 (state.json)");
  } catch (e) {
    console.warn("세션 저장 실패:", e.message);
  }
  await browser.close();
})().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
