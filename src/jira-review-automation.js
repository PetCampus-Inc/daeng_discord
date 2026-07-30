const crypto = require("crypto");

const RULE_VERSION = "ai-review-status-v3";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_CONTEXT_CHARS = 120000;
const MAX_FIGMA_IMAGES = 3;
const MAX_SUCCESSFUL_REVIEWS = 3;

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

function classifyTransition({ issueType, toStatus }) {
  const to = normalizeStatus(toStatus);
  return to === "ai리뷰" && !isTask(issueType) ? "ai-review" : null;
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

function isAutomationComment(comment) {
  const content = collectStrings(comment?.body).join("\n");
  return content.includes("AI PM 자동 리뷰") || content.includes("검토 식별자:");
}

function evidenceFingerprint(bundle, artifacts) {
  const issues = bundle.issues.map((issue) => ({
    key: issue.key,
    fields: {
      summary: issue.fields?.summary,
      description: issue.fields?.description,
      issuetype: issue.fields?.issuetype,
      parent: issue.fields?.parent,
      subtasks: issue.fields?.subtasks,
      attachment: issue.fields?.attachment,
      issuelinks: issue.fields?.issuelinks,
      comments: (issue.fields?.comment?.comments || [])
        .filter((comment) => !isAutomationComment(comment))
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          updated: comment.updated || comment.created,
        })),
    },
  }));
  const evidence = {
    issues,
    remoteLinks: bundle.remoteLinks,
    notion: artifacts.notion,
    figma: artifacts.figma.map(({ imageUrls, ...artifact }) => artifact),
    missing: artifacts.missing,
  };
  return crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
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
    "ai-review": "현재 이슈 유형과 Jira 본문·상하위·연결 이슈, 제공된 Notion/Figma 근거를 기준으로 다음 단계 진행 가능 여부를 검토하라. 자료가 없는 항목을 만들어내거나 무조건 차단하지 말고, 확인 가능한 범위와 핵심 미확인 사항을 분리하라. 개발 Task는 이 리뷰 대상이 아니다.",
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
        discord_thread_id VARCHAR(100) DEFAULT '',
        error TEXT DEFAULT '',
        evidence_hash VARCHAR(64) DEFAULT '',
        review_number INTEGER,
        skip_reason VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(100) DEFAULT ''`);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS discord_thread_id VARCHAR(100) DEFAULT ''`);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS evidence_hash VARCHAR(64) DEFAULT ''`);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS review_number INTEGER`);
    await pool.query(`ALTER TABLE jira_ai_reviews ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(100) DEFAULT ''`);
    await pool.query(`CREATE INDEX IF NOT EXISTS jira_ai_reviews_status_idx ON jira_ai_reviews(status, updated_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS jira_ai_reviews_issue_idx ON jira_ai_reviews(issue_key, processed_at DESC)`);
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
      const error = new Error(`${label} failed (${response.status}): ${body.slice(0, 500)}`);
      error.statusCode = response.status;
      error.retryAfter = Number(response.headers.get("retry-after")) || null;
      throw error;
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
    let data;
    try {
      data = await request(
        `https://api.figma.com/v1/files/${encodeURIComponent(target.fileKey)}/nodes${ids}`,
        { headers },
        "Figma nodes"
      );
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      data = await request(
        `https://api.figma.com/v1/files/${encodeURIComponent(target.fileKey)}?depth=2`,
        { headers },
        "Figma file"
      );
    }
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

    const needsNotion = false;
    const needsFigma = false;
    const missing = [];
    if (needsNotion && notionTargets.length === 0) missing.push("Notion PRD");
    if (needsFigma && figmaTargets.length === 0) missing.push("Figma 디자인");

    const notion = [];
    const notionFailures = [];
    if (needsNotion && notionTargets.length && !config.notionToken) missing.push("Notion 접근 토큰");
    if (config.notionToken) {
      for (const target of notionTargets.slice(0, 5)) {
        try {
          notion.push({ url: target.url, content: await notionPage(target.id) });
        } catch (error) {
          logger.warn(`Notion artifact unavailable (${target.url}):`, error.message);
          notionFailures.push(error);
        }
      }
    }
    if (needsNotion && notionTargets.length && config.notionToken && notion.length === 0 && notionFailures.length) {
      missing.push("Notion 접근 권한");
    }

    const figma = [];
    const figmaFailures = [];
    if (needsFigma && figmaTargets.length && !config.figmaToken) missing.push("Figma 접근 토큰");
    if (config.figmaToken) {
      for (const target of figmaTargets.slice(0, 5)) {
        try {
          figma.push({ ...target, ...(await figmaArtifact(target)) });
        } catch (error) {
          logger.warn(`Figma artifact unavailable (${target.url}):`, error.message);
          figmaFailures.push(error);
        }
      }
    }
    if (needsFigma && figmaTargets.length && config.figmaToken && figma.length === 0 && figmaFailures.length) {
      const rateLimit = figmaFailures.find((error) => error.statusCode === 429);
      if (rateLimit) {
        const retryText = rateLimit.retryAfter ? `; retry after ${rateLimit.retryAfter}s` : "";
        throw new Error(`Figma API rate limited${retryText}`);
      }
      missing.push("Figma 접근 권한");
    }
    return { notion, figma, missing: Array.from(new Set(missing)) };
  }

  function reviewProgress(reviewNumber) {
    return `AI 리뷰 ${reviewNumber}/${MAX_SUCCESSFUL_REVIEWS}`;
  }

  function missingArtifactReview(issueKey, missing, key, reviewNumber) {
    return `# AI PM 자동 리뷰 — 자료 요청

- 결론: 검토 불가
- 우선순위: P1
- 리뷰 회차: ${reviewProgress(reviewNumber)}

## 차단 이슈

- [확정] ${issueKey} 리뷰에 필요한 ${missing.join(", ")} 자료 또는 접근 권한이 없습니다.

## 다음 행동

- 해당 Sub-task 또는 상위 Story에 접근 가능한 URL을 연결하고 다시 대상 상태로 전환해 주세요.

## 검토 근거

- 검토 식별자: \`${key}\`
- 규칙 버전: \`${RULE_VERSION}\``;
  }

  async function generateReview(kind, bundle, artifacts, key, reviewNumber) {
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
    return `${result}\n\n리뷰 회차: ${reviewProgress(reviewNumber)}\n검토 식별자: \`${key}\`\n규칙 버전: \`${RULE_VERSION}\``;
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
    if (job.discord_message_id) {
      return { messageId: job.discord_message_id, threadId: job.discord_thread_id || null };
    }
    const payload = {
      ...discordPayload(job, issue, "🔄 Jira에 AI PM 리뷰 코멘트를 등록하고 있습니다."),
      thread_name: `${job.issue_key} AI PM 자동 리뷰`.slice(0, 100),
    };
    const separator = config.discordWebhook.includes("?") ? "&" : "?";
    const message = await request(
      `${config.discordWebhook}${separator}wait=true`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      "Discord preparing webhook"
    );
    return message?.id
      ? { messageId: String(message.id), threadId: message.channel_id ? String(message.channel_id) : null }
      : null;
  }

  async function completeDiscord(job, issue, review, messageId, threadId = null) {
    if (!config.discordWebhook) return;
    const resultLine = review.split("\n").find((line) => /^- 결론:/.test(line.trim())) || "- 결론: 리뷰 완료";
    const nextIndex = review.indexOf("## 다음 행동");
    const nextAction = nextIndex >= 0
      ? review.slice(nextIndex + "## 다음 행동".length).split("##")[0].trim().slice(0, 600)
      : "Jira 코멘트를 확인해 주세요.";
    const payload = discordPayload(job, issue, `✅ Jira에 리뷰 코멘트를 등록했습니다.\n${resultLine}\n${nextAction}`);
    const baseUrl = config.discordWebhook.split("?")[0];
    const threadQuery = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : "";
    const url = messageId
      ? `${baseUrl}/messages/${encodeURIComponent(messageId)}${threadQuery}`
      : `${baseUrl}?wait=true`;
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
      if (normalizeStatus(issue.fields?.status?.name) !== "ai리뷰") {
        throw new Error("Issue is no longer in AI리뷰 status");
      }

      const existingComment = await findExistingReviewComment(job.issue_key, job.review_key);
      if (existingComment) {
        await completeDiscord(
          job,
          issue,
          "- 결론: 기존 Jira 리뷰 코멘트 확인\n## 다음 행동\n- Jira 코멘트를 확인해 주세요.",
          job.discord_message_id,
          job.discord_thread_id
        ).catch(() => null);
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
      const fingerprint = evidenceFingerprint(bundle, artifacts);
      const history = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'posted')::int AS successful_reviews,
           (ARRAY_AGG(evidence_hash ORDER BY processed_at DESC)
             FILTER (WHERE status = 'posted' AND evidence_hash <> ''))[1] AS latest_evidence_hash
         FROM jira_ai_reviews
         WHERE issue_key = $1`,
        [job.issue_key]
      );
      const successfulReviews = Number(history.rows[0]?.successful_reviews || 0);
      const latestEvidenceHash = text(history.rows[0]?.latest_evidence_hash);
      if (successfulReviews >= MAX_SUCCESSFUL_REVIEWS) {
        await pool.query(
          `UPDATE jira_ai_reviews
           SET status = 'skipped', skip_reason = 'review-limit-reached',
               processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );
        return {
          status: "skipped",
          issueKey: job.issue_key,
          reason: "review-limit-reached",
          reviewCount: successfulReviews,
        };
      }
      if (latestEvidenceHash && latestEvidenceHash === fingerprint) {
        await pool.query(
          `UPDATE jira_ai_reviews
           SET status = 'skipped', skip_reason = 'evidence-unchanged',
               evidence_hash = $2, processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, fingerprint]
        );
        return {
          status: "skipped",
          issueKey: job.issue_key,
          reason: "evidence-unchanged",
          reviewCount: successfulReviews,
        };
      }
      const reviewNumber = successfulReviews + 1;
      const review = artifacts.missing.length
        ? missingArtifactReview(job.issue_key, artifacts.missing, job.review_key, reviewNumber)
        : await generateReview(actualKind, bundle, artifacts, job.review_key, reviewNumber);
      const discordNotice = await prepareDiscord(job, issue);
      const discordMessageId = discordNotice?.messageId || null;
      const discordThreadId = discordNotice?.threadId || null;
      if (discordMessageId && discordMessageId !== job.discord_message_id) {
        await pool.query(
          `UPDATE jira_ai_reviews
           SET discord_message_id = $2, discord_thread_id = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, discordMessageId, discordThreadId]
        );
        job.discord_message_id = discordMessageId;
        job.discord_thread_id = discordThreadId;
      }
      const comment = await addJiraComment(job.issue_key, review);

      try {
        await completeDiscord(job, issue, review, discordMessageId, discordThreadId);
      } catch (discordError) {
        logger.warn(`Discord review notification failed for ${job.issue_key}:`, discordError.message);
      }

      await pool.query(
        `UPDATE jira_ai_reviews
         SET status = 'posted', review_body = $2, jira_comment_id = $3,
             evidence_hash = $4, review_number = $5, skip_reason = '',
             processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, review, String(comment?.id || ""), fingerprint, reviewNumber]
      );
      return {
        status: "posted",
        issueKey: job.issue_key,
        commentId: comment?.id || null,
        reviewNumber,
      };
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
      sprintId: "all",
      summary: text(payload.summary || payload.issue?.fields?.summary),
    };
    if (!event.issueKey || !event.issueType || !event.fromStatus || !event.toStatus || !event.updatedAt) {
      const error = new Error("issueKey, issueType, fromStatus, toStatus and updatedAt are required");
      error.statusCode = 400;
      throw error;
    }
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
        triggerStatus: "AI리뷰",
        maxSuccessfulReviews: MAX_SUCCESSFUL_REVIEWS,
        excludedIssueTypes: ["Task", "작업"],
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
  MAX_SUCCESSFUL_REVIEWS,
  classifyTransition,
  extractUrls,
  parseNotionPageId,
  parseFigmaTarget,
  sprintIds,
  markdownToAdf,
  evidenceFingerprint,
  createJiraReviewAutomation,
};
