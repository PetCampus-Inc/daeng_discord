const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mondayOfISO,
  buildWeeklyReportMarkdown,
  postReportToDiscordWebhook,
} = require("./team-weekly-report");

test("mondayOfISO returns the Monday that starts the reporting period", () => {
  assert.equal(mondayOfISO("2026-08-19"), "2026-08-17");
  assert.equal(mondayOfISO("2026-08-17"), "2026-08-17");
  assert.equal(mondayOfISO("2026-08-23"), "2026-08-17");
});

test("weekly participation report summarizes checkins, delays, evidence, and insights", () => {
  const dates = [
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
    "2026-08-20",
    "2026-08-21",
  ];
  const { content, memberSummaries } = buildWeeklyReportMarkdown({
    weekStart: dates[0],
    weekEnd: dates[4],
    dates,
    users: [
      {
        userName: "철수",
        entries: [
          {
            date: dates[0],
            hasCheckin: true,
            isLate: false,
            dailyMin: 480,
            doneItems: [{ text: "KD3-101 검색 필터 개발", url: "", insight: "검색 결과를 빠르게 좁힐 수 있도록 조건 조합 흐름을 정리했습니다." }],
          },
          {
            date: dates[1],
            hasCheckin: true,
            isLate: true,
            dailyMin: 450,
            doneItems: [
              { text: "KD3-101 검색 필터 개발", url: "", insight: "검색 결과를 빠르게 좁힐 수 있도록 조건 조합 흐름을 정리했습니다." },
              { text: "KD3-108 Discord 알림 개선", url: "", insight: "알림 누락을 줄이기 위해 전송 실패 흐름을 확인했습니다." },
            ],
          },
        ],
      },
      {
        userName: "영희", entries: [],
      },
    ],
  });

  assert.match(content, /철수 · ★★★☆☆ 2\.8/);
  assert.match(content, /KD3-101 검색 필터 개발·KD3-108 Discord 알림 개선 작업을 진행했습니다/);
  assert.match(content, /체크인 2\/5일 · Delayed 1회가 확인됩니다/);
  assert.match(content, /영희 · ★★★☆☆ 2\.8/);
  assert.doesNotMatch(content, /주간 랭킹/);
  assert.equal(memberSummaries.find((member) => member.name === "철수").lateCount, 1);
});

test("weekly participation report uses AI narrative only when it contains two grounded lines", () => {
  const { content } = buildWeeklyReportMarkdown(
    {
      weekStart: "2026-08-17",
      weekEnd: "2026-08-21",
      dates: [],
      users: [{
        userName: "철수",
        entries: [{
          hasCheckin: true,
          isLate: false,
          dailyMin: 480,
          doneItems: [{ text: "KD3-101 검색 필터 개발", insight: "조건 조합 흐름을 정리했습니다." }],
        }],
      }],
    },
    {
      narratives: [{
        name: "철수",
        lines: [
          "검색 필터 개발로 사용자가 조건을 빠르게 좁힐 수 있게 했습니다.",
          "조건 조합 흐름을 정리해 다음 화면 설계의 기준을 남겼습니다.",
        ],
      }],
    }
  );

  assert.match(content, /검색 필터 개발로 사용자가 조건을 빠르게 좁힐 수 있게 했습니다/);
  assert.match(content, /조건 조합 흐름을 정리해 다음 화면 설계의 기준을 남겼습니다/);
  assert.doesNotMatch(content, /체크인 1\/5일/);
});

test("weekly participation report excludes configured members from ratings", () => {
  const { content, memberSummaries } = buildWeeklyReportMarkdown(
    {
      weekStart: "2026-08-17",
      weekEnd: "2026-08-21",
      dates: [],
      users: [{ userName: "김현수", entries: [] }],
    },
    { exemptMembers: "김현수", exemptReason: "시험기간" }
  );

  assert.match(content, /김현수 · 평가 제외/);
  assert.match(content, /사유: 시험기간/);
  assert.doesNotMatch(content, /김현수 · ★/);
  assert.equal(memberSummaries[0].exempt, true);
  assert.equal(memberSummaries[0].rating, null);
});

test("Discord forum webhook creates a thread and continues chunks in it", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ code: 220001 }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ id: `message-${calls.length}`, channel_id: "thread-123" }),
      { status: 200 }
    );
  };

  try {
    const ids = await postReportToDiscordWebhook(
      "https://discord.com/api/webhooks/example/token",
      "x".repeat(2001),
      "주간 작업 랩업 2026-08-13 ~ 2026-08-19"
    );

    assert.deepEqual(ids, ["message-2", "message-3"]);
    assert.equal(calls[1].body.thread_name, "주간 작업 랩업 2026-08-13 ~ 2026-08-19");
    assert.match(calls[2].url, /thread_id=thread-123/);
  } finally {
    global.fetch = originalFetch;
  }
});
