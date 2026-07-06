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
  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));
  return { weekStart, weekEnd: dates[6], dates };
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
        }))
        .filter((it) => it.text || it.url);
    }
  } catch (_) {
    // Legacy plain-text storage.
  }
  return [{ text: String(raw).trim(), url: (fallbackUrl || "").trim() }].filter(
    (it) => it.text || it.url
  );
}

function itemText(item) {
  if (!item.url) return item.text;
  if (!item.text) return item.url;
  return `${item.text} (${item.url})`;
}

function extractJiraKeys(text) {
  return String(text || "").match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [];
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
  const result = await pool.query(
    `SELECT user_name, check_date, start_time, end_time, hours_text,
            unavailable_text, done, tasks, blockers, checked_in_at, link_url
       FROM checkins
      WHERE check_date BETWEEN $1 AND $2
      ORDER BY user_name, check_date`,
    [weekStart, weekEnd]
  );
  const byUser = new Map();
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
  const weekdays = data.dates.slice(0, 5);
  const jiraKeys = new Set();
  const memberSummaries = data.users
    .map((user) => {
      const done = [];
      const tasks = [];
      const blockers = [];
      let checkinCount = 0;
      let lateCount = 0;
      let weeklyMin = 0;

      for (const entry of user.entries) {
        const dayLabel = entry.date.slice(5).replace("-", "/");
        if (entry.hasCheckin && weekdays.includes(entry.date)) checkinCount++;
        if (entry.isLate && weekdays.includes(entry.date)) lateCount++;
        if (typeof entry.dailyMin === "number") weeklyMin += entry.dailyMin;
        for (const item of entry.doneItems) done.push(`${dayLabel} ${itemText(item)}`);
        for (const item of entry.taskItems) tasks.push(`${dayLabel} ${itemText(item)}`);
        if (entry.blockers && entry.blockers.trim()) blockers.push(`${dayLabel} ${entry.blockers.trim()}`);
        for (const value of [...entry.doneItems, ...entry.taskItems].map(itemText)) {
          extractJiraKeys(value).forEach((key) => jiraKeys.add(key));
        }
        extractJiraKeys(entry.blockers).forEach((key) => jiraKeys.add(key));
      }

      return {
        name: user.userName,
        done,
        tasks,
        blockers,
        checkinCount,
        lateCount,
        weeklyMin,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalMin = memberSummaries.reduce((sum, m) => sum + m.weeklyMin, 0);
  const totalCheckins = memberSummaries.reduce((sum, m) => sum + m.checkinCount, 0);
  const mainTopics = [...jiraKeys].slice(0, 8);

  const lines = [
    "## 주간 팀 랩업",
    `**${data.weekStart} ~ ${data.weekEnd}**`,
    "",
    "### 전체 요약",
    `- 체크인: ${memberSummaries.map((m) => `${m.name} ${m.checkinCount}/5일`).join(", ") || "기록 없음"}`,
    `- 총 작업 시간: ${formatHours(totalMin)} (${memberSummaries.map((m) => `${m.name} ${formatHours(m.weeklyMin)}`).join(", ") || "기록 없음"})`,
    `- 주요 진행: ${mainTopics.length ? mainTopics.join(", ") : "체크인 내용을 기준으로 확인 필요"}`,
    `- 다음 주 집중: ${memberSummaries.flatMap((m) => m.tasks).slice(0, 5).map((v) => v.replace(/^\d{2}\/\d{2}\s+/, "")).join(", ") || "등록된 다음 액션 없음"}`,
    "",
    "---",
    "",
  ];

  for (const member of memberSummaries) {
    lines.push(
      `### ${member.name}`,
      `체크인 ${member.checkinCount}/5일 · 작업 시간 ${formatHours(member.weeklyMin)}${member.lateCount ? ` · Delayed ${member.lateCount}회` : ""}`,
      "",
      "**이번 주 한 일**",
      bulletList(member.done, "기록 없음"),
      "",
      "**다음 액션**",
      bulletList(member.tasks, "기록 없음"),
      "",
      "**Blocker**",
      bulletList(member.blockers, "없음"),
      "",
      "---",
      ""
    );
  }

  const allBlockers = memberSummaries.flatMap((m) => m.blockers.map((b) => `${m.name}: ${b}`));
  lines.push(
    "### 이번 주 Blocker",
    bulletList(allBlockers, "없음"),
    "",
    "### Jira 키",
    jiraKeys.size ? [...jiraKeys].sort().map((key) => `\`${key}\``).join(" ") : "없음"
  );

  if (!memberSummaries.length || totalCheckins === 0) {
    lines.push("", "", "_이번 주 체크인 기록이 없거나 체크인 내용이 비어 있습니다._");
  }

  return lines.join("\n");
}

async function generateWeeklyReport(pool, weekStart) {
  const data = await loadWeekCheckins(pool, weekStart);
  return {
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    content: buildWeeklyReportMarkdown(data),
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

async function postReportToDiscordWebhook(webhookUrl, content) {
  if (!webhookUrl) throw new Error("TEAM_WEEKLY_WEBHOOK_URL is required");
  const ids = [];
  const chunks = splitDiscordContent(content);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `**(${i + 1}/${chunks.length})**\n` : "";
    const resp = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: prefix + chunks[i],
        allowed_mentions: { parse: [] },
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Discord webhook failed (${resp.status}) ${text.slice(0, 200)}`);
    }
    try {
      const json = JSON.parse(text);
      if (json.id) ids.push(json.id);
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
  const messageIds = await postReportToDiscordWebhook(webhookUrl, report.content);
  await markWeeklyReportPosted(pool, weekStart, messageIds);
  return { ...report, messageIds };
}

module.exports = {
  currentWeekStartKST,
  previousWeekStarts,
  ensureWeeklyReportsTable,
  generateWeeklyReport,
  saveWeeklyReport,
  postReportToDiscordWebhook,
  markWeeklyReportPosted,
  generateSaveAndPostWeeklyReport,
};
