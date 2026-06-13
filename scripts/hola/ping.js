// Lightweight session refresh. Uses playwright.request (no Chromium binary needed)
// to hit /api/auth/token with the saved cookie jar, then writes the refreshed
// cookies back to state.json. Run frequently (every 1–2h) to keep the session warm.

const { request: pwRequest } = require("playwright");
const path = require("path");
const fs = require("fs");

const STATE_PATH = path.join(__dirname, "state.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

(async () => {
  if (!fs.existsSync(STATE_PATH)) {
    console.error("세션 파일이 없습니다. 먼저 'npm run hola:login' 으로 로그인하세요.");
    process.exit(2);
  }
  const ctx = await pwRequest.newContext({
    storageState: STATE_PATH,
    extraHTTPHeaders: {
      Origin: "https://holaworld.io",
      Referer: "https://holaworld.io/",
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
    },
  });

  const before = JSON.stringify((await ctx.storageState()).cookies);
  const res = await ctx.get("https://api.holaworld.io/api/auth/token");
  const status = res.status();
  console.log("auth/token →", status);

  if (status !== 200) {
    console.error("세션 만료(또는 거부) 추정. 재로그인이 필요합니다.");
    await ctx.dispose();
    process.exit(3);
  }

  await ctx.storageState({ path: STATE_PATH });
  const after = JSON.stringify((await ctx.storageState()).cookies);
  console.log(`세션 갱신 완료${before === after ? " (쿠키 변화 없음)" : " (쿠키 갱신됨)"}`);
  await ctx.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
