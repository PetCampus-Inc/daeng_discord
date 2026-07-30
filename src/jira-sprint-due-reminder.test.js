const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REMINDER_INTERVAL_DAYS,
  todayKST,
  daysBetween,
  createSprintDueReminder,
} = require("./jira-sprint-due-reminder");

test("uses a two-day reminder interval in KST", () => {
  assert.equal(REMINDER_INTERVAL_DAYS, 2);
  assert.equal(todayKST(new Date("2026-07-30T05:00:00Z")), "2026-07-30");
  assert.equal(daysBetween("2026-07-30", "2026-08-01"), 2);
});

test("posts active sprint issues missing due dates to Discord", async () => {
  const previous = {};
  const env = {
    JIRA_BASE_URL: "https://jira.example.com",
    JIRA_EMAIL: "pm@example.com",
    JIRA_API_TOKEN: "jira-token",
    REVIEW_DISCORD_WEBHOOK_URL: "https://discord.example.com/webhook",
    JIRA_REVIEW_WEBHOOK_SECRET: "secret",
  };
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("ORDER BY run_date DESC")) return { rowCount: 0, rows: [] };
      if (sql.includes("WHERE run_date = $1")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO jira_sprint_due_reminders")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/rest/agile/1.0/board?")) {
      return Response.json({ values: [{ id: 103, name: "KD3 보드" }] });
    }
    if (url.includes("/rest/agile/1.0/board/103/sprint?")) {
      return Response.json({
        values: [{ id: 339, name: "KD3 - 말티푸", state: "active", endDate: "2026-08-06T10:00:00.000Z" }],
      });
    }
    if (url.includes("/rest/api/3/search/jql?")) {
      return Response.json({
        issues: [{
          key: "KD3-112",
          fields: {
            summary: "원생 프로필 개발",
            status: { name: "진행 중" },
            assignee: { displayName: "김현수" },
            issuetype: { name: "작업" },
            duedate: null,
          },
        }],
      });
    }
    if (url === `${env.REVIEW_DISCORD_WEBHOOK_URL}?wait=true`) {
      const payload = JSON.parse(options.body);
      assert.match(payload.content, /KD3-112/);
      assert.match(payload.content, /완료 날짜가 비어 있는/);
      assert.match(payload.content, /^@everyone/);
      assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
      assert.equal(payload.thread_name, "2026-07-30 스프린트 완료 날짜 미입력");
      return Response.json({ id: "discord-message" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const reminder = createSprintDueReminder({ pool, fetchImpl, logger: { error() {} } });
    const result = await reminder.run({ now: new Date("2026-07-30T05:00:00Z") });
    assert.deepEqual(result, {
      posted: true,
      runDate: "2026-07-30",
      missingCount: 1,
      messageId: "discord-message",
    });
    assert.ok(queries.some((query) => query.sql.includes("'posted'")));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("does not run again before two calendar days have passed", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("ORDER BY run_date DESC")) {
        return { rowCount: 1, rows: [{ run_date: "2026-07-30" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const reminder = createSprintDueReminder({ pool, fetchImpl: async () => assert.fail("fetch not expected") });
  assert.equal(await reminder.isDue("2026-07-31"), false);
  assert.equal(await reminder.isDue("2026-08-01"), true);
});
