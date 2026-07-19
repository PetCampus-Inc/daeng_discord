const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyTransition,
  extractUrls,
  parseNotionPageId,
  parseFigmaTarget,
  sprintIds,
  markdownToAdf,
  createJiraReviewAutomation,
} = require("./jira-review-automation");

test("classifies only configured transitions", () => {
  assert.equal(
    classifyTransition({ issueType: "스토리", fromStatus: "기획", toStatus: "디자인" }),
    "story-planning-complete"
  );
  assert.equal(
    classifyTransition({ issueType: "작업", fromStatus: "할 일", toStatus: "진행중" }),
    "task-start"
  );
  assert.equal(
    classifyTransition({ issueType: "하위 작업", fromStatus: "진행중", toStatus: "완료", summary: "UX/UI 디자인" }),
    "artifact-subtask-complete"
  );
  assert.equal(
    classifyTransition({ issueType: "스토리", fromStatus: "할 일", toStatus: "기획" }),
    null
  );
});

test("parses Notion and Figma targets", () => {
  assert.equal(
    parseNotionPageId("https://www.notion.so/workspace/FR-01-37f6c15f67fb81b7927ac0494bf1e333?pvs=4"),
    "37f6c15f-67fb-81b7-927a-c0494bf1e333"
  );
  assert.deepEqual(
    parseFigmaTarget("https://www.figma.com/design/abcDEF/My-file?node-id=515-54668"),
    { fileKey: "abcDEF", nodeId: "515:54668", url: "https://www.figma.com/design/abcDEF/My-file?node-id=515-54668" }
  );
});

test("extracts URLs from Jira ADF-like nested data", () => {
  const urls = extractUrls({
    description: {
      content: [
        { text: "PRD https://notion.so/1234567890abcdef1234567890abcdef" },
        { attrs: { href: "https://www.figma.com/design/file/name?node-id=1-2" } },
      ],
    },
  });
  assert.equal(urls.length, 2);
});

test("reads sprint IDs from Jira field values", () => {
  assert.deepEqual(Array.from(sprintIds([{ id: 338, name: "KD3 - 비숑" }])), ["338"]);
  assert.deepEqual(Array.from(sprintIds(["com.atlassian.greenhopper.service.sprint.Sprint@1[id=338,name=x]"])), ["338"]);
});

test("converts review Markdown to Jira ADF", () => {
  const adf = markdownToAdf("# AI PM 자동 리뷰\n\n- 결론: 통과\n\n## 다음 행동\n\n- 배포한다");
  assert.equal(adf.type, "doc");
  assert.equal(adf.version, 1);
  assert.ok(adf.content.some((node) => node.type === "heading"));
  assert.ok(adf.content.some((node) => node.type === "bulletList"));
});

test("enqueue filters sprint and deduplicates review keys", async () => {
  const rows = new Map();
  let id = 0;
  const pool = {
    async query(sql, params) {
      if (!sql.includes("INSERT INTO jira_ai_reviews")) throw new Error("Unexpected query");
      const key = params[0];
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      id += 1;
      rows.set(key, params);
      return { rowCount: 1, rows: [{ id }] };
    },
  };
  const automation = createJiraReviewAutomation({ pool, fetchImpl: async () => assert.fail("fetch not expected") });
  automation.config.sprintId = "338";
  const payload = {
    issueKey: "KD3-139",
    issueType: "스토리",
    fromStatus: "기획",
    toStatus: "디자인",
    updatedAt: "2026-07-19T12:00:00.000+0900",
    sprintId: 338,
  };
  const first = await automation.enqueue(payload);
  const duplicate = await automation.enqueue(payload);
  const otherSprint = await automation.enqueue({ ...payload, sprintId: 999 });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(otherSprint.reason, "different-sprint");
});

test("processJob posts generated review directly to Jira and notifies Discord", async () => {
  const previous = {};
  const env = {
    JIRA_BASE_URL: "https://jira.example.com",
    JIRA_EMAIL: "pm@example.com",
    JIRA_API_TOKEN: "jira-token",
    OPENAI_API_KEY: "openai-token",
    REVIEW_DISCORD_WEBHOOK_URL: "https://discord.example.com/webhook",
    JIRA_REVIEW_SPRINT_ID: "338",
  };
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const job = {
    id: 1,
    review_key: "review-key",
    issue_key: "KD3-70",
    issue_type: "작업",
    from_status: "할 일",
    to_status: "진행중",
    issue_updated: "2026-07-19T12:00:00.000+0900",
    sprint_id: "338",
    review_kind: "task-start",
    status: "queued",
    attempts: 0,
  };
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("UPDATE jira_ai_reviews") && sql.includes("RETURNING *")) {
        return { rowCount: 1, rows: [{ ...job, status: "processing", attempts: 1 }] };
      }
      if (sql.startsWith("UPDATE jira_ai_reviews")) {
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/rest/api/3/issue/KD3-70?") && (!options.method || options.method === "GET")) {
      return Response.json({
        key: "KD3-70",
        fields: {
          summary: "구성원 탭 개발",
          issuetype: { name: "작업" },
          status: { name: "진행중" },
          customfield_10020: [{ id: 338, name: "KD3 - 비숑" }],
          subtasks: [],
          issuelinks: [],
          description: null,
          attachment: [],
          comment: { comments: [] },
        },
      });
    }
    if (url.includes("/rest/api/3/issue/KD3-70/comment?")) return Response.json({ comments: [] });
    if (url.endsWith("/rest/api/3/issue/KD3-70/remotelink")) return Response.json([]);
    if (url === "https://api.openai.com/v1/responses") {
      return Response.json({ output_text: "# AI PM 자동 리뷰\n- 결론: 통과\n## 다음 행동\n- 구현 범위를 유지합니다." });
    }
    if (url.endsWith("/rest/api/3/issue/KD3-70/comment")) return Response.json({ id: "12345" });
    if (url === `${env.REVIEW_DISCORD_WEBHOOK_URL}?wait=true`) {
      assert.match(options.body, /thread_name/);
      return Response.json({ id: "discord-1", channel_id: "thread-1" });
    }
    if (url === `${env.REVIEW_DISCORD_WEBHOOK_URL}/messages/discord-1?thread_id=thread-1`) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const automation = createJiraReviewAutomation({ pool, fetchImpl, logger: { warn() {}, error() {} } });
    const result = await automation.processJob(1);
    assert.deepEqual(result, { status: "posted", issueKey: "KD3-70", commentId: "12345" });
    const jiraPost = calls.find((call) => call.url.endsWith("/comment"));
    assert.equal(jiraPost.options.method, "POST");
    assert.match(jiraPost.options.body, /AI PM 자동 리뷰/);
    const preparingIndex = calls.findIndex((call) => call.url.endsWith("?wait=true"));
    const jiraIndex = calls.findIndex((call) => call.url.endsWith("/comment"));
    const completionIndex = calls.findIndex((call) => call.url.endsWith("/messages/discord-1?thread_id=thread-1"));
    assert.ok(preparingIndex >= 0 && preparingIndex < jiraIndex);
    assert.ok(completionIndex > jiraIndex);
    assert.equal(calls[completionIndex].options.method, "PATCH");
    assert.ok(updates.some((update) => update.sql.includes("status = 'posted'")));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
