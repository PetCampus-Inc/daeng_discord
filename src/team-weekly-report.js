const DISCORD_CONTENT_LIMIT = 2000;
const SAFE_DISCORD_CONTENT_LIMIT = 1850;
const CHECKIN_GRACE_MIN = 30;

function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOfISO(dateISO) {
  const d = new Date(dateISO + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function currentWeekStartKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const iso = kst.toISOString().slice(0, 10);
  return mondayOfISO(iso);
}

function weekRange(weekStart) {
  const dates = Array.from({ length: 5 }, (_, i) => addDaysISO(weekStart, i));
  return { weekStart, weekEnd: dates[4], dates };
}

function previousWeekStarts(count, baseWeekStart = currentWeekStartKST()) {
  return Array.from({ length: count }, (_, i) => addDaysISO(baseWeekStart, -7 * (count - i)));
}

function hhmmToMin(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const WORKDAY_START_MIN = 7 * 60;
const WORKDAY_LEN = 20 * 60;

function toVirtMin(clockMin) {
  if (clockMin === null || clockMin === undefined) return null;
  if (clockMin >= WORKDAY_START_MIN && clockMin <= 24 * 60) {
    return clockMin - WORKDAY_START_MIN;
  }
  if (clockMin >= 0 && clockMin <= 3 * 60) {
    return clockMin + (24 * 60 - WORKDAY_START_MIN);
  }
  return null;
}

const FREEFORM_RANGE_RE = /(\d{1,2})(?::(\d{2}))?\s*[-~–—]\s*(\d{1,2})(?::(\d{2}))?/;

function parseRangeFromText(text) {
  if (!text) return { start: null, end: null };
  const m = String(text).match(FREEFORM_RANGE_RE);
  if (!m) return { start: null, end: null };
  const sh = Number(m[1]);
  const sm = Number(m[2] || 0);
  const eh = Number(m[3]);
  const em = Number(m[4] || 0);
  if (sh > 24 || eh > 24 || sm > 59 || em > 59) return { start: null, end: null };
  const pad = (n) => String(n).padStart(2, "0");
  return { start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh)}:${pad(em)}` };
}

function dailyMinutes(startTime, endTime, unavailableText) {
  const svm = toVirtMin(hhmmToMin(startTime));
  const evm = toVirtMin(hhmmToMin(endTime));
  if (svm === null || evm === null || evm <= svm) return null;
  let total = evm - svm;
  if (unavailableText) {
    const segments = String(unavailableText).split(";").map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const u = parseRangeFromText(seg);
      const usvm = toVirtMin(hhmmToMin(u.start));
      const uevm = toVirtMin(hhmmToMin(u.end));
      if (usvm !== null && uevm !== null && uevm > usvm) {
        const overlap = Math.max(0, Math.min(evm, uevm) - Math.max(svm, usvm));
        total -= overlap;
      }
    }
  }
  return Math.max(0, total);
}

function formatHours(min) {
  if (!min) return "0h";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function isLateCheckin(startTime, checkedInAt) {
  const sm = hhmmToMin(startTime);
  const cm = hhmmToMin(checkedInAt);
  if (sm === null || cm === null) return false;
  return cm > sm + CHECKIN_GRACE_MIN;
}

function itemsFromStorage(raw, fallbackUrl) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((it) => ({
          text: (it && typeof it.text === "string" ? it.text : "").trim(),
          url: (it && typeof it.url === "string" ? it.url : "").trim(),
          insight: (it && typeof it.insight === "string" ? it.insight : "").trim(),
        }))
        .filter((it) => it.text || it.url || it.insight);
    }
  } catch (_) {
    // Legacy plain-text storage.
  }
  return [{ text: String(raw).trim(), url: (fallbackUrl || "").trim(), insight: "" }].filter(
    (it) => it.text || it.url
  );
}

function extractJiraKeys(text) {
  return String(text || "").match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [];
}

function ticketKeysFromItem(item) {
  const textKeys = extractJiraKeys(item && item.text);
  const url = String((item && item.url) || "");
  const urlKeys = url.includes("atlassian.net") ? extractJiraKeys(url) : [];
  return [...new Set(urlKeys.length ? urlKeys : textKeys)];
}

function itemTitleWithoutTicket(item) {
  return String((item && item.text) || "")
    .replace(/^\s*\[[A-Z][A-Z0-9]+-\d+\]\s*/, "")
    .replace(/^\s*[A-Z][A-Z0-9]+-\d+\s*/, "")
    .trim();
}

function bulletList(items, emptyText = "-") {
  const cleaned = items.map((v) => String(v || "").trim()).filter(Boolean);
  if (!cleaned.length) return `- ${emptyText}`;
  return cleaned.map((v) => `- ${v}`).join("\n");
}

async function ensureWeeklyReportsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id SERIAL PRIMARY KEY,
      week_start DATE NOT NULL UNIQUE,
      week_end DATE NOT NULL,
      content TEXT NOT NULL,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      posted_at TIMESTAMP,
      discord_message_id TEXT DEFAULT ''
    )
  `);
}

async function loadWeekCheckins(pool, weekStart) {
  const { weekEnd, dates } = weekRange(weekStart);
  const [result, membersResult] = await Promise.all([
    pool.query(
    `SELECT user_name, check_date, start_time, end_time, hours_text,
            unavailable_text, done, tasks, blockers, checked_in_at, link_url
       FROM checkins
      WHERE check_date BETWEEN $1 AND $2
      ORDER BY user_name, check_date`,
    [weekStart, weekEnd]
    ),
    pool.query(`SELECT name FROM team_members WHERE archived = FALSE ORDER BY name`),
  ]);
  const byUser = new Map();
  for (const row of membersResult.rows) byUser.set(row.name, []);
  for (const row of result.rows) {
    const date =
      row.check_date instanceof Date
        ? row.check_date.toISOString().slice(0, 10)
        : String(row.check_date).slice(0, 10);
    if (!byUser.has(row.user_name)) byUser.set(row.user_name, []);
    const doneItems = itemsFromStorage(row.done, row.link_url);
    const taskItems = itemsFromStorage(row.tasks, "");
    const hasCheckin =
      doneItems.length > 0 ||
      taskItems.length > 0 ||
      String(row.blockers || "").trim() !== "";
    byUser.get(row.user_name).push({
      date,
      startTime: row.start_time || "",
      endTime: row.end_time || "",
      hoursText: row.hours_text || "",
      unavailableText: row.unavailable_text || "",
      doneItems,
      taskItems,
      blockers: row.blockers || "",
      checkedInAt: row.checked_in_at || "",
      hasCheckin,
      isLate: hasCheckin && isLateCheckin(row.start_time, row.checked_in_at),
      dailyMin: dailyMinutes(row.start_time, row.end_time, row.unavailable_text),
    });
  }
  return {
    weekStart,
    weekEnd,
    dates,
    users: [...byUser.entries()].map(([userName, entries]) => ({ userName, entries })),
  };
}

function buildWeeklyReportMarkdown(data) {
  const memberSummaries = data.users
    .map((user) => {
      let checkinCount = 0;
      let lateCount = 0;
      let weeklyMin = 0;
      const evidence = [];
      const insights = [];
      for (const entry of user.entries) {
        if (entry.hasCheckin) checkinCount++;
        if (entry.isLate) lateCount++;
        if (typeof entry.dailyMin === "number") weeklyMin += entry.dailyMin;
        for (const item of [...(entry.doneItems || []), ...(entry.taskItems || entry.tasksItems || [])]) {
          if (item?.text) evidence.push(item.text);
          if (item?.insight) insights.push(item.insight);
        }
      }
      return {
        name: user.userName,
        checkinCount,
        lateCount,
        weeklyMin,
        evidence: [...new Set(evidence)].slice(0, 6),
        insights: [...new Set(insights)].slice(0, 6),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalMin = memberSummaries.reduce((sum, member) => sum + member.weeklyMin, 0);
  const totalCheckins = memberSummaries.reduce((sum, member) => sum + member.checkinCount, 0);
  const totalLate = memberSummaries.reduce((sum, member) => sum + member.lateCount, 0);
  const lines = [
    "## 🐶 주간 참여 리포트",
    `**${data.weekStart}(월) ~ ${data.weekEnd}(금)**`,
    "출결·Delayed·결과물·Insight를 기반으로 정리한 기록입니다.",
    "",
  ];

  for (const member of memberSummaries) {
    lines.push(
      `### ${member.name} · 출결 ${member.checkinCount}/5일${member.lateCount ? ` · Delayed ${member.lateCount}회` : ""}`,
      `- 작업시간: ${formatHours(member.weeklyMin)}`,
      `- 결과물: ${member.evidence.length ? member.evidence.join(" / ") : "기록 없음"}`,
      `- Insight: ${member.insights.length ? member.insights.join(" / ") : "기록 없음"}`,
      ""
    );
  }

  lines.push(
    "---",
    "",
    "### 팀 요약",
    `- 총 작업시간: ${formatHours(totalMin)}`,
    `- 참여 인원: ${memberSummaries.length}명`,
    `- 체크인: ${totalCheckins}건`,
    `- Delayed: ${totalLate}회`
  );
  if (!memberSummaries.length || totalCheckins === 0) {
    lines.push("", "_이번 주 체크인 기록이 없거나 체크인 내용이 비어 있습니다._");
  }
  return { content: lines.join("\n"), memberSummaries };
}

function rankMembers(members, field) {
  let previousValue = null;
  let previousRank = 0;
  return [...members]
    .sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name))
    .map((member, index) => {
      const rank = member[field] === previousValue ? previousRank : index + 1;
      previousValue = member[field];
      previousRank = rank;
      return { ...member, rank };
    });
}

function rankingLines(rankedMembers, formatValue) {
  if (!rankedMembers.length) return ["- 기록 없음"];
  return rankedMembers.map(
    (member) => `${member.rank}. ${member.name} — ${formatValue(member)}`
  );
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  return (response?.output || [])
    .flatMap((item) => item?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function generateParticipationInsights(memberSummaries, {
  openaiKey = process.env.OPENAI_API_KEY,
  openaiModel = process.env.OPENAI_MODEL || "gpt-5-mini",
  fetchImpl = fetch,
} = {}) {
  if (!openaiKey || !memberSummaries.length) return "";
  const facts = JSON.stringify(memberSummaries, null, 2).slice(0, 30000);
  const prompt = `당신은 팀 운영 리포트 작성자다. 아래 체크인 집계만 근거로 한국어 Markdown을 작성하라.
각 구성원마다 '참여 현황', '결과물·Insight 근거', '다음 주 확인 사항'을 한 줄씩 쓴다.
체크인 3일 미만, Delayed 반복, 결과물 또는 Insight 부재는 '확인 필요'로 분명히 표시한다.
근거 없는 업무 성과나 사유를 만들지 말고, 사람의 하차 여부를 판단하거나 결정하지 않는다.
랭킹·점수·비교 표현은 쓰지 않는다.

집계 데이터:
${facts}`;
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel,
      input: prompt,
      max_output_tokens: 1800,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI weekly report failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return responseText(await response.json());
}

async function generateWeeklyReport(pool, weekStart, options = {}) {
  const data = await loadWeekCheckins(pool, weekStart);
  const { content: factualContent, memberSummaries } = buildWeeklyReportMarkdown(data);
  let aiContent = "";
  try {
    aiContent = await generateParticipationInsights(memberSummaries, options);
  } catch (error) {
    console.error("Weekly participation AI report error:", error.message);
    aiContent = "_AI 참여 인사이트 생성에 실패했습니다. 위의 사실 기록을 확인해 주세요._";
  }
  return {
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    content: aiContent ? `${factualContent}\n\n---\n\n## AI 참여 인사이트\n${aiContent}` : factualContent,
  };
}

async function saveWeeklyReport(pool, report) {
  await ensureWeeklyReportsTable(pool);
  const result = await pool.query(
    `INSERT INTO weekly_reports (week_start, week_end, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (week_start) DO UPDATE SET
       week_end = EXCLUDED.week_end,
       content = EXCLUDED.content,
       generated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [report.weekStart, report.weekEnd, report.content]
  );
  return result.rows[0];
}

function splitDiscordContent(content) {
  if (content.length <= DISCORD_CONTENT_LIMIT) return [content];
  const chunks = [];
  let remaining = content;
  while (remaining.length) {
    if (remaining.length <= SAFE_DISCORD_CONTENT_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n---\n", SAFE_DISCORD_CONTENT_LIMIT);
    if (cut < 500) cut = remaining.lastIndexOf("\n### ", SAFE_DISCORD_CONTENT_LIMIT);
    if (cut < 500) cut = remaining.lastIndexOf("\n", SAFE_DISCORD_CONTENT_LIMIT);
    if (cut < 500) cut = SAFE_DISCORD_CONTENT_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

async function postReportToDiscordWebhook(webhookUrl, content, threadName = "주간 참여 리포트") {
  if (!webhookUrl) throw new Error("TEAM_WEEKLY_WEBHOOK_URL is required");
  const ids = [];
  const chunks = splitDiscordContent(content);
  let forumMode = false;
  let forumThreadId = "";
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `**(${i + 1}/${chunks.length})**\n` : "";
    const payload = {
      content: prefix + chunks[i],
      allowed_mentions: { parse: [] },
    };
    const url = new URL(webhookUrl);
    url.searchParams.set("wait", "true");
    if (forumThreadId) url.searchParams.set("thread_id", forumThreadId);
    let resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let text = await resp.text();
    if (!resp.ok && i === 0) {
      let errorCode = null;
      try {
        errorCode = JSON.parse(text).code;
      } catch (_) {
        // Keep the original Discord response for the error below.
      }
      if (errorCode === 220001) {
        forumMode = true;
        payload.thread_name = String(threadName || "주간 참여 리포트").slice(0, 100);
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        text = await resp.text();
      }
    }
    if (!resp.ok) {
      throw new Error(`Discord webhook failed (${resp.status}) ${text.slice(0, 200)}`);
    }
    try {
      const json = JSON.parse(text);
      if (json.id) ids.push(json.id);
      if (forumMode && !forumThreadId && json.channel_id) forumThreadId = json.channel_id;
    } catch (_) {
      // Discord may return an empty body if wait behavior changes.
    }
  }
  return ids;
}

async function markWeeklyReportPosted(pool, weekStart, messageIds) {
  await pool.query(
    `UPDATE weekly_reports
        SET posted_at = CURRENT_TIMESTAMP,
            discord_message_id = $2
      WHERE week_start = $1`,
    [weekStart, messageIds.join(",")]
  );
}

async function generateSaveAndPostWeeklyReport(pool, weekStart, webhookUrl) {
  const report = await generateWeeklyReport(pool, weekStart);
  await saveWeeklyReport(pool, report);
  const messageIds = await postReportToDiscordWebhook(
    webhookUrl,
    report.content,
    `주간 참여 리포트 ${report.weekStart} ~ ${report.weekEnd}`
  );
  await markWeeklyReportPosted(pool, weekStart, messageIds);
  return { ...report, messageIds };
}

module.exports = {
  mondayOfISO,
  currentWeekStartKST,
  previousWeekStarts,
  ensureWeeklyReportsTable,
  buildWeeklyReportMarkdown,
  generateWeeklyReport,
  saveWeeklyReport,
  postReportToDiscordWebhook,
  markWeeklyReportPosted,
  generateSaveAndPostWeeklyReport,
};
