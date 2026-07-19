const crypto = require("crypto");

const RULE_VERSION = "sprint-status-review-v1";
const DEFAULT_SPRINT_ID = "338";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_CONTEXT_CHARS = 120000;
const MAX_FIGMA_IMAGES = 3;

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function normalizeStatus(value) {
  return text(value).replace(/\s+/g, "").toLowerCase();
}

function normalizeIssueType(value) {
  return text(value).replace(/\s+/g, "").toLowerCase();
}

function isStory(issueType) {
  return ["story", "스토리"].includes(normalizeIssueType(issueType));
}

function isTask(issueType) {
  return ["task", "작업"].includes(normalizeIssueType(issueType));
}

function isSubtask(issueType) {
  return ["subtask", "sub-task", "하위작업", "하위 작업"].includes(
    normalizeIssueType(issueType)
  );
}

function classifyTransition({ issueType, fromStatus, toStatus, summary = "" }) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);

  if (isStory(issueType) && from === "기획" && to === "디자인") {
    return "story-planning-complete";
  }
  if (isStory(issueType) && from === "디자인" && to === "완료") {
    return "story-design-complete";
  }
  if (isTask(issueType) && from === "할일" && to === "진행중") {
    return "task-start";
  }
  if (isTask(issueType) && from === "진행중" && to === "완료") {
    return "task-complete";
  }
  if (isSubtask(issueType) && to === "완료" && /(기획|디자인|ux|ui)/i.test(summary)) {
    return "artifact-subtask-complete";
  }
  if (from === "완료" && to !== "완료") {
    return "review-regressed";
  }
  return null;
}

function safeEqual(actual, expected) {
  const a = Buffer.from(text(actual));
  const b = Buffer.from(text(expected));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function extractUrls(value) {
  const urls = new Set();
  for (const chunk of collectStrings(value)) {
    const matches = chunk.match(/https?:\/\/[^\s<>()\]"']+/gi) || [];
    for (const match of matches) urls.add(match.replace(/[.,;:]+$/, ""));
  }
  return Array.from(urls);
}

function parseNotionPageId(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)notion\.(so|site)$|(^|\.)notion\.com$/.test(parsed.hostname)) return null;
    const candidates = [
      ...parsed.pathname.split("/").filter(Boolean).reverse(),
      ...Array.from(parsed.searchParams.values()),
    ];
    const match = candidates
      .map((candidate) => candidate.replace(/-/g, "").match(/([0-9a-f]{32})$/i))
      .find(Boolean);
    if (!match) return null;
    const id = match[1].toLowerCase();
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  } catch (_) {
    return null;
  }
}

function parseFigmaTarget(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)figma\.com$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/\/(?:file|design|proto)\/([^/]+)/i);
    if (!match) return null;
    const nodeId = parsed.searchParams.get("node-id");
    return { fileKey: match[1], nodeId: nodeId ? nodeId.replace(/-/g, ":") : null, url };
  } catch (_) {
    return null;
  }
}

function sprintIds(value) {
  const ids = new Set();
  const visit = (item) => {
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item === "object") {
      if (item.id !== undefined) ids.add(String(item.id));
      return Object.values(item).forEach(visit);
    }
    if (typeof item === "string") {
      const matches = item.match(/(?:id=|"id"\s*:\s*)(\d+)/g) || [];
      for (const match of matches) {
        const id = match.match(/\d+/)?.[0];
        if (id) ids.add(id);
      }
    }
  };
  visit(value);
  return ids;
}

function clip(value, max = MAX_CONTEXT_CHARS) {
  const string = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return string.length <= max ? string : `${string.slice(0, max)}\n...[truncated]`;
}

function adfTextNode(value) {
  return { type: "text", text: String(value).slice(0, 30000) };
}

function markdownToAdf(markdown) {
  const content = [];
  for (const rawLine of String(markdown).split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: [adfTextNode(heading[2])],
      });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      content.push({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [adfTextNode(bullet[1])] }] }],
      });
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      content.push({
        type: "orderedList",
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [adfTextNode(ordered[1])] }] }],
      });
      continue;
    }
    content.push({ type: "paragraph", content: [adfTextNode(line)] });
  }
  return {
    version: 1,
    type: "doc",
    content: content.length ? content : [{ type: "paragraph", content: [adfTextNode("AI PM 리뷰 결과가 비어 있습니다.")] }],
  };
}

function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  const parts = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function reviewKey(event) {
  return crypto
    .createHash("sha256")
    .update(
      [event.issueKey, event.fromStatus, event.toStatus, event.updatedAt, RULE_VERSION].map(text).join("|")
    )
    .digest("hex");
}

function reviewPrompt(kind) {
  const common = `당신은 똑독(Knockdog)의 Senior Product Manager이자 Product Designer다.
현재 제품 단계는 MVP이며 최상위 목표는 첫 실제 사용자 확보, 핵심 KPI는 가입 수다.
확인된 사실은 [확정], 검증이 필요한 추정은 [가설]과 검증 방법, 정보가 없으면 [미확인]으로 구분한다.
근거 없는 사용자 특성, 수치, 구현 상태를 만들지 않는다.
결론을 먼저 쓰고 가장 중요한 다음 행동 하나를 지정한다.
Jira에 바로 게시될 한국어 Markdown 코멘트만 작성한다.
형식은 반드시 다음 순서를 따른다:
# AI PM 자동 리뷰
- 결론: 통과 / 보완 후 진행 / 완료 보류 / 검토 불가
- 우선순위: P0 / P1 / P2 / P3 / P4
## 차단 이슈
## 주요 피드백
## 다음 행동
## 검토 근거
각 주요 피드백은 관찰 근거, 원인(미확인이면 표시), 영향, 수정 방법을 포함한다.`;

  const instructions = {
    "story-planning-complete": "Notion PRD의 문제·대상·목표, MVP 범위, 인수 조건, 권한·상태·오류·빈 상태와 미확인 정책을 검토하라. 디자인 착수 가능 여부를 결론낸다.",
    "story-design-complete": "승인된 PRD와 Figma의 요구사항·흐름·문구·상태가 일치하는지, 오류 후 복구와 개발 전달 범위가 충분한지 검토하라.",
    "artifact-subtask-complete": "완료된 기획 또는 디자인 Sub-task의 산출물을 상위 Story 목적과 비교해 검토하라.",
    "task-start": "개발 Task의 Epic·Story 직접 매핑, FE·BE 분해, 요구사항 커버리지, 선행 의존성과 착수 가능성을 검토하라. Task 자체에 PRD·Figma 첨부를 요구하지 않는다.",
    "task-complete": "개발 Task의 Story 완료 조건, FE·BE 구현 증거, 연동, 미완료 Sub-task와 의존성을 검토하라. 코드 품질은 평가하지 않는다.",
  };
  return `${common}\n\n이번 리뷰 유형: ${kind}\n${instructions[kind] || "제공된 근거를 기준으로 검토하라."}`;
}

function createJiraReviewAutomation({ pool, fetchImpl = fetch, logger = console } = {}) {
  if (!pool) throw new Error("pool is required");

  const config = {
    jiraBaseUrl: text(process.env.JIRA_BASE_URL).replace(/\/$/, ""),
    jiraEmail: text(process.env.JIRA_EMAIL),
    jiraToken: text(process.env.JIRA_API_TOKEN),
    notionToken: text(process.env.NOTION_TOKEN),
    figmaToken: text(process.env.FIGMA_ACCESS_TOKEN),
    openaiKey: text(process.env.OPENAI_API_KEY),
    openaiModel: text(process.env.OPENAI_MODEL) || DEFAULT_MODEL,
    discordWebhook: text(process.env.REVIEW_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL),
    planningRoleId: text(process.env.DISCORD_PLANNING_ROLE_ID),
    developmentRoleId: text(process.env.DISCORD_DEVELOPMENT_ROLE_ID),
    webhookSecret: text(process.env.JIRA_REVIEW_WEBHOOK_SECRET),
    sprintId: text(process.env.JIRA_REVIEW_SPRINT_ID) || DEFAULT_SPRINT_ID,
    sprintField: text(process.env.JIRA_SPRINT_FIELD) || "customfield_10020",
  };

  async function ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jira_ai_reviews (
        id BIGSERIAL PRIMARY KEY,
        review_key VARCHAR(64) UNIQUE NOT NULL,
        issue_key VARCHAR(50) NOT NULL,
        issue_type VARCHAR(100) NOT NULL,
        from_status VARCHAR(100) NOT NULL,
        to_status VARCHAR(100) NOT NULL,
        issue_updated VARCHAR(100) NOT NULL,
        sprint_id VARCHAR(30) NOT NULL,
        review_kind VARCHAR(80) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        review_body TEXT DEFAULT '',
        jira_comment_id VARCHAR(100) DEFAULT '',
        discord_message_id VARCHAR(100) DEFAULT '',
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(100) DEFAULT ''`);
    await pool.query(`CREATE INDEX IF NOT EXISTS jira_ai_reviews_status_idx ON jira_ai_reviews(status, updated_at)`);
  }

  function assertRuntimeConfig() {
    const required = [
      ["JIRA_BASE_URL", config.jiraBaseUrl],
      ["JIRA_EMAIL", config.jiraEmail],
      ["JIRA_API_TOKEN", config.jiraToken],
      ["OPENAI_API_KEY", config.openaiKey],
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Missing review configuration: ${missing.join(", ")}`);
  }

  async function request(url, options = {}, label = "request") {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${label} failed (${response.status}): ${body.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function jiraHeaders(json = false) {
    const headers = {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString("base64")}`,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function jiraGet(pathname) {
    return request(`${config.jiraBaseUrl}${pathname}`, { headers: jiraHeaders() }, `Jira GET ${pathname}`);
  }

  async function getIssue(issueKey) {
    const fields = [
      "summary", "description", "status", "issuetype", "parent", "subtasks", "attachment",
      "issuelinks", "comment", "updated", config.sprintField,
    ].join(",");
    return jiraGet(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`);
  }

  async function getRemoteLinks(issueKey) {
    try {
      return await jiraGet(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`);
    } catch (error) {
      logger.warn(`Remote links unavailable for ${issueKey}:`, error.message);
      return [];
    }
  }

  async function addJiraComment(issueKey, markdown) {
    return request(
      `${config.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { method: "POST", headers: jiraHeaders(true), body: JSON.stringify({ body: markdownToAdf(markdown) }) },
      `Jira comment ${issueKey}`
    );
  }

  async function findExistingReviewComment(issueKey, key) {
    const comments = await jiraGet(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=100&orderBy=-created`
    ).catch(() => null);
    return (comments?.comments || []).find((comment) => collectStrings(comment.body).some((value) => value.includes(key))) || null;
  }

  async function notionPage(pageId) {
    const headers = {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": "2022-06-28",
      Accept: "application/json",
    };
    const page = await request(`https://api.notion.com/v1/pages/${pageId}`, { headers }, "Notion page");
    const lines = collectStrings(page.properties).filter(Boolean);
    let blockCount = 0;
    async function readChildren(blockId, depth) {
      if (depth > 4 || blockCount >= 500) return;
      let cursor = null;
      let pageCount = 0;
      do {
        const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
        const blocks = await request(
          `https://api.notion.com/v1/blocks/${blockId}/children${query}`,
          { headers },
          "Notion blocks"
        );
        for (const block of blocks.results || []) {
          blockCount += 1;
          const blockText = collectStrings(block[block.type]).filter(Boolean).join(" ");
          if (blockText) lines.push(blockText);
          if (block.has_children && blockCount < 500) await readChildren(block.id, depth + 1);
        }
        cursor = blocks.has_more ? blocks.next_cursor : null;
        pageCount += 1;
      } while (cursor && pageCount < 5 && blockCount < 500);
    }
    await readChildren(pageId, 0);
    return clip(lines.join("\n"), 80000);
  }

  async function figmaArtifact(target) {
    const headers = { "X-Figma-Token": config.figmaToken };
    const ids = target.nodeId ? `?ids=${encodeURIComponent(target.nodeId)}` : "?depth=2";
    const data = await request(
      `https://api.figma.com/v1/files/${encodeURIComponent(target.fileKey)}/nodes${ids}`,
      { headers },
      "Figma nodes"
    ).catch(async () => {
      return request(
        `https://api.figma.com/v1/files/${encodeURIComponent(target.fileKey)}?depth=2`,
        { headers },
        "Figma file"
      );
    });
    const imageUrls = [];
    if (target.nodeId) {
      const images = await request(
        `https://api.figma.com/v1/images/${encodeURIComponent(target.fileKey)}?ids=${encodeURIComponent(target.nodeId)}&format=png&scale=1`,
        { headers },
        "Figma image"
      ).catch(() => null);
      const imageUrl = images?.images?.[target.nodeId];
      if (imageUrl) imageUrls.push(imageUrl);
    }
    return { context: clip(data, 50000), imageUrls };
  }

  async function collectIssueBundle(issue, kind) {
    const issueKeys = new Set([issue.key]);
    if (issue.fields?.parent?.key) issueKeys.add(issue.fields.parent.key);
    for (const subtask of issue.fields?.subtasks || []) issueKeys.add(subtask.key);
    for (const link of issue.fields?.issuelinks || []) {
      const linked = link.inwardIssue || link.outwardIssue;
      if (linked?.key && (isStory(linked.fields?.issuetype?.name) || kind.startsWith("task-"))) {
        issueKeys.add(linked.key);
      }
    }

    const issues = [];
    const remoteLinks = [];
    for (const key of Array.from(issueKeys).slice(0, 15)) {
      const detail = key === issue.key ? issue : await getIssue(key).catch(() => null);
      if (detail) issues.push(detail);
      const links = await getRemoteLinks(key);
      remoteLinks.push(...links);
    }
    const urls = new Set(extractUrls({ issues, remoteLinks }));
    for (const link of remoteLinks) {
      if (link?.object?.url) urls.add(link.object.url);
    }
    return { issues, remoteLinks, urls: Array.from(urls) };
  }

  async function loadArtifacts(bundle, kind) {
    const notionTargets = [];
    const figmaTargets = [];
    for (const url of bundle.urls) {
      const notionId = parseNotionPageId(url);
      if (notionId && !notionTargets.some((item) => item.id === notionId)) notionTargets.push({ id: notionId, url });
      const figma = parseFigmaTarget(url);
      if (figma && !figmaTargets.some((item) => item.fileKey === figma.fileKey && item.nodeId === figma.nodeId)) {
        figmaTargets.push(figma);
      }
    }

    const needsNotion = ["story-planning-complete", "story-design-complete", "artifact-subtask-complete"].includes(kind);
    const needsFigma = ["story-design-complete"].includes(kind);
    const missing = [];
    if (needsNotion && notionTargets.length === 0) missing.push("Notion PRD");
    if (needsFigma && figmaTargets.length === 0) missing.push("Figma 디자인");

    const notion = [];
    if (notionTargets.length && !config.notionToken) missing.push("Notion 접근 토큰");
    if (config.notionToken) {
      for (const target of notionTargets.slice(0, 5)) {
        try {
          notion.push({ url: target.url, content: await notionPage(target.id) });
        } catch (error) {
          logger.warn(`Notion artifact unavailable (${target.url}):`, error.message);
          missing.push("Notion 접근 권한");
        }
      }
    }

    const figma = [];
    if (figmaTargets.length && !config.figmaToken) missing.push("Figma 접근 토큰");
    if (config.figmaToken) {
      for (const target of figmaTargets.slice(0, 5)) {
        try {
          figma.push({ ...target, ...(await figmaArtifact(target)) });
        } catch (error) {
          logger.warn(`Figma artifact unavailable (${target.url}):`, error.message);
          missing.push("Figma 접근 권한");
        }
      }
    }
    return { notion, figma, missing: Array.from(new Set(missing)) };
  }

  function missingArtifactReview(issueKey, missing, key) {
    return `# AI PM 자동 리뷰 — 자료 요청

- 결론: 검토 불가
- 우선순위: P1

## 차단 이슈

- [확정] ${issueKey} 리뷰에 필요한 ${missing.join(", ")} 자료 또는 접근 권한이 없습니다.

## 다음 행동

- 해당 Sub-task 또는 상위 Story에 접근 가능한 URL을 연결하고 다시 대상 상태로 전환해 주세요.

## 검토 근거

- 검토 식별자: \`${key}\`
- 규칙 버전: \`${RULE_VERSION}\``;
  }

  async function generateReview(kind, bundle, artifacts, key) {
    const issueContext = clip(bundle.issues, 60000);
    const artifactContext = clip({ notion: artifacts.notion, figma: artifacts.figma.map(({ imageUrls, ...rest }) => rest) }, 60000);
    const content = [
      { type: "input_text", text: `${reviewPrompt(kind)}\n\nJira 근거:\n${issueContext}\n\n산출물 근거:\n${artifactContext}\n\n검토 식별자: ${key}` },
    ];
    const imageUrls = artifacts.figma.flatMap((item) => item.imageUrls || []).slice(0, MAX_FIGMA_IMAGES);
    for (const imageUrl of imageUrls) content.push({ type: "input_image", image_url: imageUrl, detail: "high" });

    const response = await request(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.openaiModel,
          instructions: "근거가 없는 내용은 만들지 말고, 제공된 Jira·PRD·Figma 자료만 사용하라.",
          input: [{ role: "user", content }],
          max_output_tokens: 6000,
        }),
      },
      "OpenAI Responses API"
    );
    const result = outputText(response);
    if (!result) throw new Error("OpenAI returned an empty review");
    return `${result}\n\n검토 식별자: \`${key}\`\n규칙 버전: \`${RULE_VERSION}\``;
  }

  function discordPayload(job, issue, body) {
    const task = isTask(job.issue_type);
    const roleId = task ? config.developmentRoleId : config.planningRoleId;
    const mention = roleId ? `<@&${roleId}> ` : "";
    return {
      content: `${mention}**[AI PM 자동 리뷰] ${job.issue_key} ${issue.fields?.summary || ""}**\n${body}\n${config.jiraBaseUrl}/browse/${job.issue_key}`.slice(0, 1900),
      allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
    };
  }

  async function prepareDiscord(job, issue) {
    if (!config.discordWebhook) return null;
    if (job.discord_message_id) return job.discord_message_id;
    const payload = discordPayload(job, issue, "🔄 Jira에 AI PM 리뷰 코멘트를 등록하고 있습니다.");
    const separator = config.discordWebhook.includes("?") ? "&" : "?";
    const message = await request(
      `${config.discordWebhook}${separator}wait=true`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      "Discord preparing webhook"
    );
    return message?.id ? String(message.id) : null;
  }

  async function completeDiscord(job, issue, review, messageId) {
    if (!config.discordWebhook) return;
    const resultLine = review.split("\n").find((line) => /^- 결론:/.test(line.trim())) || "- 결론: 리뷰 완료";
    const nextIndex = review.indexOf("## 다음 행동");
    const nextAction = nextIndex >= 0
      ? review.slice(nextIndex + "## 다음 행동".length).split("##")[0].trim().slice(0, 600)
      : "Jira 코멘트를 확인해 주세요.";
    const payload = discordPayload(job, issue, `✅ Jira에 리뷰 코멘트를 등록했습니다.\n${resultLine}\n${nextAction}`);
    const baseUrl = config.discordWebhook.split("?")[0];
    const url = messageId ? `${baseUrl}/messages/${encodeURIComponent(messageId)}` : `${baseUrl}?wait=true`;
    await request(
      url,
      { method: messageId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      "Discord completion webhook"
    );
  }

  async function notifyFailure(job, error) {
    if (!config.discordWebhook) return;
    const roleId = isTask(job.issue_type) ? config.developmentRoleId : config.planningRoleId;
    const mention = roleId ? `<@&${roleId}> ` : "";
    const payload = {
      content: `${mention}**[AI PM 자동 리뷰 실패] ${job.issue_key}**\n3회 처리에 실패했습니다. Jira 상태는 변경하지 않았습니다.\n${String(error.message || error).slice(0, 500)}\n${config.jiraBaseUrl}/browse/${job.issue_key}`.slice(0, 1900),
      allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
    };
    await request(
      config.discordWebhook,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      "Discord failure webhook"
    );
  }

  async function processJob(id) {
    const claimed = await pool.query(
      `UPDATE jira_ai_reviews
       SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP, error = ''
       WHERE id = $1 AND status IN ('queued', 'failed') AND attempts < 3
       RETURNING *`,
      [id]
    );
    const job = claimed.rows[0];
    if (!job) return null;

    try {
      assertRuntimeConfig();
      const issue = await getIssue(job.issue_key);
      const actualType = issue.fields?.issuetype?.name || job.issue_type;
      const actualKind = classifyTransition({
        issueType: actualType,
        fromStatus: job.from_status,
        toStatus: job.to_status,
        summary: issue.fields?.summary || "",
      });
      if (!actualKind || actualKind !== job.review_kind) throw new Error("Transition no longer matches review rules");

      const ids = sprintIds(issue.fields?.[config.sprintField]);
      if (!ids.has(config.sprintId)) throw new Error(`Issue is not in configured sprint ${config.sprintId}`);

      if (actualKind === "review-regressed") {
        await pool.query(
          `UPDATE jira_ai_reviews SET status = 'regressed', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id]
        );
        return { status: "regressed" };
      }

      const existingComment = await findExistingReviewComment(job.issue_key, job.review_key);
      if (existingComment) {
        await completeDiscord(job, issue, "- 결론: 기존 Jira 리뷰 코멘트 확인\n## 다음 행동\n- Jira 코멘트를 확인해 주세요.", job.discord_message_id).catch(() => null);
        await pool.query(
          `UPDATE jira_ai_reviews
           SET status = 'posted', jira_comment_id = $2, processed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP, error = ''
           WHERE id = $1`,
          [id, String(existingComment.id || "")]
        );
        return { status: "posted", issueKey: job.issue_key, commentId: existingComment.id || null, recovered: true };
      }

      const bundle = await collectIssueBundle(issue, actualKind);
      const artifacts = await loadArtifacts(bundle, actualKind);
      const review = artifacts.missing.length
        ? missingArtifactReview(job.issue_key, artifacts.missing, job.review_key)
        : await generateReview(actualKind, bundle, artifacts, job.review_key);
      const discordMessageId = await prepareDiscord(job, issue);
      if (discordMessageId && discordMessageId !== job.discord_message_id) {
        await pool.query(
          `UPDATE jira_ai_reviews SET discord_message_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id, discordMessageId]
        );
        job.discord_message_id = discordMessageId;
      }
      const comment = await addJiraComment(job.issue_key, review);

      try {
        await completeDiscord(job, issue, review, discordMessageId);
      } catch (discordError) {
        logger.warn(`Discord review notification failed for ${job.issue_key}:`, discordError.message);
      }

      await pool.query(
        `UPDATE jira_ai_reviews
         SET status = 'posted', review_body = $2, jira_comment_id = $3,
             processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, review, String(comment?.id || "")]
      );
      return { status: "posted", issueKey: job.issue_key, commentId: comment?.id || null };
    } catch (error) {
      await pool.query(
        `UPDATE jira_ai_reviews SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, String(error.message || error).slice(0, 4000)]
      );
      if (job.attempts >= 3) await notifyFailure(job, error).catch(() => null);
      logger.error(`Jira AI review failed for job ${id}:`, error.message);
      throw error;
    }
  }

  async function processPending(limit = 5) {
    const pending = await pool.query(
      `SELECT id FROM jira_ai_reviews
       WHERE status = 'queued'
          OR (status = 'failed' AND attempts < 3 AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 seconds')
       ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    for (const row of pending.rows) {
      await processJob(row.id).catch(() => null);
    }
    return pending.rowCount;
  }

  async function enqueue(payload) {
    const event = {
      issueKey: text(payload.issueKey || payload.issue?.key),
      issueType: text(payload.issueType || payload.issue?.fields?.issuetype?.name),
      fromStatus: text(payload.fromStatus || payload.changelog?.status?.fromString),
      toStatus: text(payload.toStatus || payload.changelog?.status?.toString),
      updatedAt: text(payload.updatedAt || payload.issue?.fields?.updated),
      sprintId: text(payload.sprintId) || config.sprintId,
      summary: text(payload.summary || payload.issue?.fields?.summary),
    };
    if (!event.issueKey || !event.issueType || !event.fromStatus || !event.toStatus || !event.updatedAt) {
      const error = new Error("issueKey, issueType, fromStatus, toStatus and updatedAt are required");
      error.statusCode = 400;
      throw error;
    }
    if (event.sprintId !== config.sprintId) return { accepted: false, reason: "different-sprint" };
    const kind = classifyTransition(event);
    if (!kind) return { accepted: false, reason: "transition-not-configured" };
    const key = reviewKey(event);
    const inserted = await pool.query(
      `INSERT INTO jira_ai_reviews
        (review_key, issue_key, issue_type, from_status, to_status, issue_updated, sprint_id, review_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (review_key) DO NOTHING
       RETURNING id`,
      [key, event.issueKey, event.issueType, event.fromStatus, event.toStatus, event.updatedAt, event.sprintId, kind]
    );
    if (!inserted.rowCount) return { accepted: false, duplicate: true, reviewKey: key };
    return { accepted: true, id: inserted.rows[0].id, reviewKey: key, kind };
  }

  async function webhook(req, res) {
    if (!config.webhookSecret) return res.status(503).json({ error: "JIRA_REVIEW_WEBHOOK_SECRET is not configured" });
    if (!safeEqual(req.get("x-jira-webhook-secret"), config.webhookSecret)) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    try {
      const result = await enqueue(req.body || {});
      if (result.accepted) setImmediate(() => processJob(result.id).catch(() => null));
      return res.status(result.accepted ? 202 : 200).json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  }

  async function health(req, res) {
    if (!config.webhookSecret || !safeEqual(req.get("x-jira-webhook-secret"), config.webhookSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const counts = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM jira_ai_reviews GROUP BY status ORDER BY status`
      );
      return res.json({
        ready: Boolean(config.jiraBaseUrl && config.jiraEmail && config.jiraToken && config.openaiKey),
        sprintId: config.sprintId,
        ruleVersion: RULE_VERSION,
        integrations: {
          jira: Boolean(config.jiraBaseUrl && config.jiraEmail && config.jiraToken),
          notion: Boolean(config.notionToken),
          figma: Boolean(config.figmaToken),
          openai: Boolean(config.openaiKey),
          discord: Boolean(config.discordWebhook),
        },
        queue: counts.rows,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return {
    config,
    ensureTable,
    webhook,
    health,
    enqueue,
    processJob,
    processPending,
  };
}

module.exports = {
  RULE_VERSION,
  classifyTransition,
  extractUrls,
  parseNotionPageId,
  parseFigmaTarget,
  sprintIds,
  markdownToAdf,
  createJiraReviewAutomation,
};
