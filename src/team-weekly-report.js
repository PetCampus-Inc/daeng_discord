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

function normalizedMemberName(name) {
  return String(name || "").replace(/^👑\s*/, "").trim();
}

function excludedMemberNames(value) {
  const source = value === undefined ? process.env.TEAM_WEEKLY_EXEMPT_MEMBERS || "" : value;
  const names = Array.isArray(source) ? source : String(source).split(",");
  return new Set(names.map(normalizedMemberName).filter(Boolean));
}

function contributionRating(member) {
  const raw =
    member.checkinCount * 12 +
    member.outputCount * 2 +
    member.taskCount +
    member.insightCount +
    Math.min(member.weeklyMin / 60, 60) * 0.05 -
    member.lateCount * 3;
  const rating = Math.max(2.8, Math.min(4.8, 3.5 + (raw - 74.5) * 0.1));
  return Math.round(rating * 10) / 10;
}

function ratingStars(rating) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
}

function cleanReviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function defaultReviewLines(member) {
  const artifacts = member.evidence.slice(0, 3).map(cleanReviewText).filter(Boolean);
  const artifactText = artifacts.length ? artifacts.join("·") : "체크인에 남긴 작업";
  const insight = cleanReviewText(member.insights[0]);
  const firstLine = insight
    ? `${artifactText} 작업을 진행했습니다. ${insight}`
    : `${artifactText} 작업을 진행하며 이번 주 업무를 이어갔습니다.`;

  if (member.checkinCount < 5 || member.lateCount > 0 || member.outputCount + member.taskCount < 3) {
    const issues = [
      member.checkinCount < 5 ? `체크인 ${member.checkinCount}/5일` : "",
      member.lateCount > 0 ? `Delayed ${member.lateCount}회` : "",
      member.outputCount + member.taskCount < 3 ? "작업 기록 부족" : "",
    ].filter(Boolean).join(" · ");
    return [
      firstLine,
      `${issues}가 확인됩니다. 다음 주에는 완료 결과물·링크·작업 판단을 함께 남겨 기여 내용을 검증 가능하게 해주세요.`,
    ];
  }

  return [
    firstLine,
    "완료한 작업과 다음 작업의 맥락이 기록되어 있어, 다음 주에도 결과물 링크와 검증 내용을 함께 남겨주세요.",
  ];
}

function normalizeNarratives(narratives) {
  const byName = new Map();
  for (const narrative of narratives || []) {
    const name = normalizedMemberName(narrative?.name);
    const lines = Array.isArray(narrative?.lines)
      ? narrative.lines.map(cleanReviewText).filter(Boolean).slice(0, 2)
      : [];
    if (name && lines.length === 2) byName.set(name, lines);
  }
  return byName;
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
    pool.query(
      `SELECT name
         FROM team_members
        WHERE archived = FALSE
          AND TRIM(name) <> ''
          AND TRIM(name) <> '-'
        ORDER BY name`
    ),
  ]);
  const byUser = new Map();
  for (const row of membersResult.rows) byUser.set(row.name, []);
  for (const row of result.rows) {
    if (!normalizedMemberName(row.user_name) || String(row.user_name).trim() === "-") continue;
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

function buildWeeklyReportMarkdown(data, options = {}) {
  const exemptNames = excludedMemberNames(options.exemptMembers);
  const exemptReason = String(options.exemptReason || process.env.TEAM_WEEKLY_EXEMPT_REASON || "운영상 이번 주 평가에서 제외").trim();
  const narratives = normalizeNarratives(options.narratives);
  const memberSummaries = data.users
    .map((user) => {
      let checkinCount = 0;
      let lateCount = 0;
      let weeklyMin = 0;
      let outputCount = 0;
      let taskCount = 0;
      let insightCount = 0;
      const evidence = [];
      const insights = [];
      for (const entry of user.entries) {
        if (entry.hasCheckin) checkinCount++;
        if (entry.isLate) lateCount++;
        if (typeof entry.dailyMin === "number") weeklyMin += entry.dailyMin;
        for (const item of entry.doneItems || []) {
          if (item?.text) evidence.push(item.text);
          if (item?.text) outputCount++;
          if (item?.insight) {
            insights.push(item.insight);
            insightCount++;
          }
        }
        for (const item of entry.taskItems || entry.tasksItems || []) {
          if (item?.text) evidence.push(item.text);
          if (item?.text) taskCount++;
          if (item?.insight) {
            insights.push(item.insight);
            insightCount++;
          }
        }
      }
      const member = {
        name: user.userName,
        checkinCount,
        lateCount,
        weeklyMin,
        outputCount,
        taskCount,
        insightCount,
        evidence: [...new Set(evidence)].slice(0, 6),
        insights: [...new Set(insights)].slice(0, 6),
      };
      member.exempt = exemptNames.has(normalizedMemberName(member.name));
      member.rating = member.exempt ? null : contributionRating(member);
      return member;
    })
    .sort((a, b) => (b.rating || -1) - (a.rating || -1) || a.name.localeCompare(b.name));

  const evaluatedMembers = memberSummaries.filter((member) => !member.exempt);
  const totalMin = evaluatedMembers.reduce((sum, member) => sum + member.weeklyMin, 0);
  const totalCheckins = evaluatedMembers.reduce((sum, member) => sum + member.checkinCount, 0);
  const totalLate = evaluatedMembers.reduce((sum, member) => sum + member.lateCount, 0);
  const lines = [
    "## 🐶 주간 기여도 리뷰",
    `**${data.weekStart}(월) ~ ${data.weekEnd}(금)**`,
    "출결·Delayed·결과물·할 일·Insight를 기반으로 산정한 주간 기록입니다.",
    "",
  ];

  for (const member of memberSummaries) {
    if (member.exempt) {
      lines.push(
        `### ${member.name} · 평가 제외`,
        `- 사유: ${exemptReason}.`,
        "- 이번 주 기록은 참고로만 남기며, 별점·순위·팀 평균에는 반영하지 않습니다.",
        ""
      );
      continue;
    }
    const reviewLines = narratives.get(normalizedMemberName(member.name)) || defaultReviewLines(member);
    lines.push(
      `### ${member.name} · ${ratingStars(member.rating)} ${member.rating.toFixed(1)}`,
      "",
      ...reviewLines,
      ""
    );
  }

  lines.push(
    "---",
    "",
    "### 팀 요약",
    `- 총 작업시간: ${formatHours(totalMin)}`,
    `- 평가 인원: ${evaluatedMembers.length}명${memberSummaries.length !== evaluatedMembers.length ? ` · 평가 제외 ${memberSummaries.length - evaluatedMembers.length}명` : ""}`,
    `- 체크인: ${totalCheckins}건`,
    `- Delayed: ${totalLate}회`
  );
  if (!evaluatedMembers.length || totalCheckins === 0) {
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
  const prompt = `당신은 팀 운영 리포트 작성자다. 아래 체크인 집계만 근거로 각 구성원의 주간 기여 사유를 작성하라.
반드시 JSON만 반환한다. 형식은 {"members":[{"name":"이름","lines":["문장 1","문장 2"]}]} 이다.
각 구성원의 문장은 정확히 두 문장이다. 첫 문장은 evidence에 있는 구체 작업물 1~3개를 직접 언급하고, 그 작업이 해결한 문제 또는 팀·서비스에 준 영향을 설명한다. 두 번째 문장은 Insight 또는 작업의 연결성을 설명한다. 낮은 기록(체크인 미달, Delayed, 결과물 부족)이 있으면 두 번째 문장에서 관찰 사실을 바탕으로 다음 주 개선 행동을 구체적으로 제시한다.
근거 없는 업무 성과·링크·사유를 만들지 말고, 사람의 하차 여부를 판단하거나 결정하지 않는다. 평점·순위·비교 표현은 쓰지 않는다.

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
  const text = responseText(await response.json()).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.members) ? parsed.members : [];
}

async function generateWeeklyReport(pool, weekStart, options = {}) {
  const data = await loadWeekCheckins(pool, weekStart);
  const { memberSummaries } = buildWeeklyReportMarkdown(data, options);
  let narratives = [];
  try {
    narratives = await generateParticipationInsights(memberSummaries.filter((member) => !member.exempt), options);
  } catch (error) {
    console.error("Weekly participation AI report error:", error.message);
  }
  const { content } = buildWeeklyReportMarkdown(data, { ...options, narratives });
  return {
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    content,
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

async function generateSaveAndPostWeeklyReport(pool, weekStart, webhookUrl, options = {}) {
  const report = await generateWeeklyReport(pool, weekStart, options);
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
