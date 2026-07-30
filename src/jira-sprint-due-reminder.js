const crypto = require("crypto");

const REMINDER_INTERVAL_DAYS = 2;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function todayKST(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function safeEqual(actual, expected) {
  const a = Buffer.from(text(actual));
  const b = Buffer.from(text(expected));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createSprintDueReminder({ pool, fetchImpl = fetch, logger = console } = {}) {
  if (!pool) throw new Error("pool is required");

  const config = {
    jiraBaseUrl: text(process.env.JIRA_BASE_URL).replace(/\/$/, ""),
    jiraEmail: text(process.env.JIRA_EMAIL),
    jiraToken: text(process.env.JIRA_API_TOKEN),
    projectKey: text(process.env.JIRA_SPRINT_REMINDER_PROJECT) || "KD3",
    discordWebhook: text(process.env.REVIEW_DISCORD_WEBHOOK_URL),
    planningRoleId: text(process.env.DISCORD_PLANNING_ROLE_ID),
    webhookSecret: text(process.env.JIRA_REVIEW_WEBHOOK_SECRET),
  };

  async function ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jira_sprint_due_reminders (
        id BIGSERIAL PRIMARY KEY,
        run_date DATE UNIQUE NOT NULL,
        status VARCHAR(30) NOT NULL,
        missing_count INTEGER NOT NULL DEFAULT 0,
        discord_message_id VARCHAR(100) DEFAULT '',
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        posted_at TIMESTAMP
      )
    `);
  }

  function jiraHeaders() {
    return {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString("base64")}`,
    };
  }

  async function requestJson(url, options = {}, label = "request") {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${label} failed (${response.status}): ${body.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function getActiveSprints() {
    const boards = await requestJson(
      `${config.jiraBaseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(config.projectKey)}&maxResults=100`,
      { headers: jiraHeaders() },
      "Jira boards"
    );
    const sprints = [];
    for (const board of boards.values || []) {
      const response = await requestJson(
        `${config.jiraBaseUrl}/rest/agile/1.0/board/${board.id}/sprint?state=active&maxResults=100`,
        { headers: jiraHeaders() },
        `Jira active sprints for board ${board.id}`
      );
      for (const sprint of response.values || []) {
        if (!sprints.some((item) => item.id === sprint.id)) sprints.push(sprint);
      }
    }
    return sprints;
  }

  async function getMissingDueIssues(sprintId) {
    const url = new URL("/rest/api/3/search/jql", config.jiraBaseUrl);
    url.searchParams.set(
      "jql",
      `project = ${config.projectKey} AND sprint = ${sprintId} AND resolution = Unresolved AND duedate is EMPTY ORDER BY Rank ASC`
    );
    url.searchParams.set("fields", "summary,status,assignee,issuetype,duedate");
    url.searchParams.set("maxResults", "100");
    const response = await requestJson(url.toString(), { headers: jiraHeaders() }, "Jira missing due dates");
    return response.issues || [];
  }

  async function collectMissingDueDates() {
    const sprints = await getActiveSprints();
    const results = [];
    for (const sprint of sprints) {
      const issues = await getMissingDueIssues(sprint.id);
      if (issues.length) results.push({ sprint, issues });
    }
    return results;
  }

  function buildDiscordPayload(results, runDate) {
    const roleMention = config.planningRoleId ? `<@&${config.planningRoleId}> ` : "";
    const total = results.reduce((sum, item) => sum + item.issues.length, 0);
    const lines = [
      `${roleMention}**[Jira] 스프린트 완료 날짜 미입력 알림**`,
      `현재 활성 스프린트에서 완료 날짜가 비어 있는 미완료 티켓이 **${total}개** 있습니다.`,
      "",
    ];
    for (const { sprint, issues } of results) {
      const endDate = text(sprint.endDate).slice(0, 10) || "미입력";
      lines.push(`**${sprint.name}** · 스프린트 종료일 ${endDate}`);
      for (const issue of issues) {
        const assignee = issue.fields?.assignee?.displayName || "담당자 없음";
        const status = issue.fields?.status?.name || "상태 미확인";
        lines.push(`- [${issue.key}](${config.jiraBaseUrl}/browse/${issue.key}) ${issue.fields?.summary || ""} · ${assignee} · ${status}`);
      }
      lines.push("");
    }
    lines.push("각 티켓의 완료 날짜를 입력해 주세요.");
    return {
      content: lines.join("\n").slice(0, 1950),
      allowed_mentions: {
        parse: [],
        roles: config.planningRoleId ? [config.planningRoleId] : [],
      },
      thread_name: `${runDate} 스프린트 완료 날짜 미입력`.slice(0, 100),
    };
  }

  async function isDue(runDate) {
    const latest = await pool.query(
      `SELECT run_date::text
       FROM jira_sprint_due_reminders
       WHERE status IN ('posted', 'empty')
       ORDER BY run_date DESC
       LIMIT 1`
    );
    const lastRunDate = latest.rows[0]?.run_date;
    return !lastRunDate || daysBetween(lastRunDate, runDate) >= REMINDER_INTERVAL_DAYS;
  }

  async function run({ force = false, now = new Date() } = {}) {
    if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraToken || !config.discordWebhook) {
      throw new Error("Missing Jira sprint reminder configuration");
    }
    const runDate = todayKST(now);
    if (!force && !(await isDue(runDate))) {
      return { posted: false, reason: "interval-not-reached", runDate };
    }
    const existing = await pool.query(
      `SELECT status, missing_count FROM jira_sprint_due_reminders WHERE run_date = $1`,
      [runDate]
    );
    if (existing.rowCount) {
      return { posted: false, reason: "already-ran-today", runDate, ...existing.rows[0] };
    }

    try {
      const results = await collectMissingDueDates();
      const missingCount = results.reduce((sum, item) => sum + item.issues.length, 0);
      if (!missingCount) {
        await pool.query(
          `INSERT INTO jira_sprint_due_reminders (run_date, status, missing_count, posted_at)
           VALUES ($1, 'empty', 0, CURRENT_TIMESTAMP)`,
          [runDate]
        );
        return { posted: false, reason: "no-missing-due-dates", runDate, missingCount: 0 };
      }
      const separator = config.discordWebhook.includes("?") ? "&" : "?";
      const message = await requestJson(
        `${config.discordWebhook}${separator}wait=true`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildDiscordPayload(results, runDate)),
        },
        "Discord sprint due reminder"
      );
      await pool.query(
        `INSERT INTO jira_sprint_due_reminders
          (run_date, status, missing_count, discord_message_id, posted_at)
         VALUES ($1, 'posted', $2, $3, CURRENT_TIMESTAMP)`,
        [runDate, missingCount, String(message?.id || "")]
      );
      return { posted: true, runDate, missingCount, messageId: message?.id || null };
    } catch (error) {
      logger.error("Jira sprint due reminder failed:", error.message);
      await pool.query(
        `INSERT INTO jira_sprint_due_reminders (run_date, status, error)
         VALUES ($1, 'failed', $2)
         ON CONFLICT (run_date) DO UPDATE SET status = 'failed', error = EXCLUDED.error`,
        [runDate, String(error.message || error).slice(0, 4000)]
      ).catch(() => null);
      throw error;
    }
  }

  async function manualRun(req, res) {
    if (!config.webhookSecret || !safeEqual(req.get("x-jira-webhook-secret"), config.webhookSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      return res.json(await run({ force: true }));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return {
    config,
    ensureTable,
    collectMissingDueDates,
    buildDiscordPayload,
    isDue,
    run,
    manualRun,
  };
}

module.exports = {
  REMINDER_INTERVAL_DAYS,
  todayKST,
  daysBetween,
  createSprintDueReminder,
};
