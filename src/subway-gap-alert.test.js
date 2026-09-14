const test = require("node:test");
const assert = require("node:assert/strict");
const {
  monitoringWindow,
  parseTrainPositions,
  findGaps,
  createSubwayGapAlert,
} = require("./subway-gap-alert");

function train(id, stationCode, station, direction = 2, state = "도착") {
  return `<div class="T${stationCode}_Y_${direction}_v2 tip"
    title="${id}열차  ${station} ${state} 사당행" data-statnTcd="0433"></div>`;
}

function mapHtml(...trains) {
  return `<div class="4line" title="4호선 노선도"><div class="4line_metro">${trains.join("")}</div></div>`;
}

test("uses a constant two-station threshold from 07:30 through 09:09 KST", () => {
  assert.equal(monitoringWindow(new Date("2026-09-14T07:29:59+09:00")), null);
  assert.equal(monitoringWindow(new Date("2026-09-14T07:30:00+09:00")).threshold, 2);
  assert.equal(monitoringWindow(new Date("2026-09-14T08:59:59+09:00")).threshold, 2);
  assert.equal(monitoringWindow(new Date("2026-09-14T09:00:00+09:00")).threshold, 2);
  assert.equal(monitoringWindow(new Date("2026-09-14T09:09:59+09:00")).threshold, 2);
  assert.equal(monitoringWindow(new Date("2026-09-14T09:10:00+09:00")), null);
});

test("keeps only southbound trains from Sanggye through Gireum", () => {
  const positions = parseTrainPositions(mapHtml(
    train("4201", "0409", "불암산"),
    train("4202", "0410", "상계"),
    train("4203", "0412", "창동"),
    train("4204", "0417", "길음", 1),
    train("4205", "0417", "길음", 2, "출발"),
    train("4206", "0418", "성신여대입구")
  ));
  assert.deepEqual(positions.map((position) => position.id), ["4202", "4203"]);
  assert.deepEqual(findGaps(positions, 2).map((gap) => gap.distance), [2]);
  assert.deepEqual(findGaps(positions, 3), []);
});

test("alerts after two observations, deduplicates, and still detects two stations after 09:00", async () => {
  let html = mapHtml(train("4201", "0412", "창동"), train("4203", "0410", "상계"));
  const posts = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("traininfoUserMap.do")) return new Response(html);
    posts.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };
  const alert = createSubwayGapAlert({
    fetchImpl,
    env: { SUBWAY_GAP_DISCORD_WEBHOOK_URL: "https://discord.example/webhook" },
  });
  const beforeNine = new Date("2026-09-14T08:58:00+09:00");
  await alert.run({ now: beforeNine });
  assert.equal(posts.length, 0);
  await alert.run({ now: beforeNine });
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /2정거장/);
  assert.match(posts[0].thread_name, /4호선 간격 알림/);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
  await alert.run({ now: beforeNine });
  assert.equal(posts.length, 1);

  const afterNine = new Date("2026-09-14T09:00:00+09:00");
  await alert.run({ now: afterNine });
  assert.equal(posts.length, 1);
  html = mapHtml(train("4201", "0411", "노원"), train("4203", "0410", "상계"));
  await alert.run({ now: afterNine });
  assert.equal(posts.length, 1);
  html = mapHtml(train("4201", "0412", "창동"), train("4203", "0410", "상계"));
  await alert.run({ now: afterNine });
  assert.equal(posts.length, 1);
  await alert.run({ now: afterNine });
  assert.equal(posts.length, 2);
  assert.match(posts[1].content, /2정거장/);
});

test("does not fetch outside the window or post when source HTML is invalid", async () => {
  let calls = 0;
  const alert = createSubwayGapAlert({
    env: { SUBWAY_GAP_DISCORD_WEBHOOK_URL: "https://discord.example/webhook" },
    fetchImpl: async () => { calls++; return new Response("error page"); },
  });
  const outside = await alert.run({ now: new Date("2026-09-14T09:10:00+09:00") });
  assert.equal(outside.skipped, true);
  assert.equal(calls, 0);
  await assert.rejects(alert.run({ now: new Date("2026-09-14T08:00:00+09:00") }), /unexpected HTML/);
  assert.equal(calls, 1);
});

test("a failed source poll breaks the two-observation streak", async () => {
  let sourceCalls = 0;
  let posts = 0;
  const html = mapHtml(train("4201", "0412", "창동"), train("4203", "0410", "상계"));
  const alert = createSubwayGapAlert({
    env: { SUBWAY_GAP_DISCORD_WEBHOOK_URL: "https://discord.example/webhook" },
    fetchImpl: async (url) => {
      if (url.includes("traininfoUserMap.do")) {
        sourceCalls++;
        return sourceCalls === 2 ? new Response("unavailable", { status: 503 }) : new Response(html);
      }
      posts++;
      return new Response(null, { status: 204 });
    },
  });
  const now = new Date("2026-09-14T08:00:00+09:00");
  await alert.run({ now });
  await assert.rejects(alert.run({ now }), /source failed \(503\)/);
  await alert.run({ now });
  assert.equal(posts, 0);
  await alert.run({ now });
  assert.equal(posts, 1);
});
