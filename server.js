const express = require("express");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const cron = require("node-cron");
const { Pool, types: pgTypes } = require("pg");

// Keep DATE (OID 1082) as raw "YYYY-MM-DD" string to avoid TZ shifts
pgTypes.setTypeParser(1082, (val) => val);
const { getAssigneeStats, getProjects, getProjectStatuses, getMyIssues } = require("./src/jira-client");
const {
  currentWeekStartKST,
  ensureWeeklyReportsTable,
  generateSaveAndPostWeeklyReport,
} = require("./src/team-weekly-report");

const app = express();
const PORT = process.env.PORT || 5000;
const LEGACY_PORT = 5000;

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memos (
        id SERIAL PRIMARY KEY,
        week_key VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        color VARCHAR(20) DEFAULT 'yellow',
        author VARCHAR(100) DEFAULT 'Anonymous',
        position_x INTEGER DEFAULT 0,
        position_y INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
        visitor_id VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(visit_date, visitor_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS polls (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        options TEXT[] NOT NULL,
        created_by VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        deadline TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
        voter_name VARCHAR(100) NOT NULL,
        selected_option INTEGER NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(poll_id, voter_name)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        category VARCHAR(50) DEFAULT 'general',
        author VARCHAR(100) NOT NULL,
        likes INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idea_likes (
        id SERIAL PRIMARY KEY,
        idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
        user_name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(idea_id, user_name)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcement_reads (
        id SERIAL PRIMARY KEY,
        announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
        user_name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(announcement_id, user_name)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        check_date DATE NOT NULL DEFAULT CURRENT_DATE,
        user_name VARCHAR(100) NOT NULL,
        start_time VARCHAR(5),
        end_time VARCHAR(5),
        work_mode VARCHAR(20) DEFAULT 'office',
        tasks TEXT,
        blockers TEXT,
        mood VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(check_date, user_name)
      )
    `);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS done TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS hours_text TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS unavailable_text TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS checked_in_at VARCHAR(5)`);
    await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS link_url TEXT DEFAULT ''`);
    await ensureWeeklyReportsTable(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT DEFAULT '',
        page_url TEXT DEFAULT '',
        reporter_name VARCHAR(100) DEFAULT '',
        status VARCHAR(20) DEFAULT 'pending',
        decided_by VARCHAR(100) DEFAULT '',
        decided_at TIMESTAMP,
        decision_note TEXT DEFAULT '',
        automation_status VARCHAR(30) DEFAULT '',
        automation_url TEXT DEFAULT '',
        automation_error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS automation_status VARCHAR(30) DEFAULT ''`);
    await pool.query(`ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS automation_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS automation_error TEXT DEFAULT ''`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        archived BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS team VARCHAR(50) DEFAULT ''`);
    const memberCount = await pool.query(`SELECT COUNT(*) FROM team_members`);
    if (parseInt(memberCount.rows[0].count, 10) === 0) {
      for (const name of ["손흥민", "하정우", "민지", "진영"]) {
        await pool.query(
          `INSERT INTO team_members (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [name]
        );
      }
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quick_links (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        url TEXT NOT NULL,
        icon_url TEXT DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const qlCount = await pool.query(`SELECT COUNT(*) FROM quick_links`);
    if (parseInt(qlCount.rows[0].count, 10) === 0) {
      const seeds = [
        ["Jira", "https://jira-knockdog.atlassian.net/jira/your-work", "https://cdn.worldvectorlogo.com/logos/jira-1.svg"],
        ["Notion", "https://www.notion.so/2de6c15f67fb8039b0f7e6e9c7fe202f?v=2de6c15f67fb815e809d000ce19fbfe7", "https://upload.wikimedia.org/wikipedia/commons/4/45/Notion_app_logo.png"],
        ["Figma", "https://www.figma.com/", "https://cdn.worldvectorlogo.com/logos/figma-icon.svg"],
        ["Home", "https://home.knockdog.net/", "https://home.knockdog.net/favicon.ico"],
        ["Swagger", "https://api.knockdog.net/swagger-ui/index.html", "https://static1.smartbear.co/swagger/media/assets/images/swagger_logo.svg"],
        ["AWS", "https://aws.amazon.com/console/", "https://a0.awsstatic.com/libra-css/images/logos/aws_smile-header-desktop-en-white_59x35.png"],
      ];
      for (let i = 0; i < seeds.length; i++) {
        await pool.query(
          `INSERT INTO quick_links (name, url, icon_url, position) VALUES ($1, $2, $3, $4)`,
          [seeds[i][0], seeds[i][1], seeds[i][2], i]
        );
      }
    }
    console.log("Database initialized");
  } catch (err) {
    console.error("Database init error:", err.message);
  }
}

initDatabase();

const todayKST = () => {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};
const CHECKIN_GRACE_MIN = 30;
function nowMinKST() {
  const k = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}
function hhmmToMin(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function minToHHMM(min) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
}
function nowHHMMKST() {
  const k = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return minToHHMM(k.getUTCHours() * 60 + k.getUTCMinutes());
}
// done/tasks: optionally a JSON array of {text, url}. Legacy string == single item.
function normalizeItems(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((it) => ({
        text: typeof it?.text === "string" ? it.text.trim() : "",
        url: typeof it?.url === "string" ? it.url.trim() : "",
      }))
      .filter((it) => it.text || it.url);
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    return [{ text: t, url: "" }];
  }
  return undefined;
}
function itemsToStorage(items) {
  if (!Array.isArray(items)) return undefined;
  if (items.length === 0) return "";
  return JSON.stringify(items);
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
    // not JSON — treat as plain text (legacy)
  }
  return [{ text: String(raw).trim(), url: (fallbackUrl || "").trim() }].filter(
    (it) => it.text || it.url
  );
}
function itemsFlatText(items) {
  return items.map((i) => i.text).filter(Boolean).join("\n");
}

function isLateCheckin(startTime, checkedInAt) {
  const sm = hhmmToMin(startTime);
  const cm = hhmmToMin(checkedInAt);
  if (sm === null || cm === null) return false;
  return cm > sm + CHECKIN_GRACE_MIN;
}
// Workday = 07:00 → 03:00 next day (20h). Map clock minutes to a 0–1200 virtual axis.
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
function mondayOfISO(dateISO) {
  const d = new Date(dateISO + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function getWeekRange(weekStartParam) {
  let monday;
  if (weekStartParam) {
    monday = new Date(weekStartParam + "T00:00:00Z");
  } else {
    monday = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const day = monday.getUTCDay();
    const diff = (day + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - diff);
  }
  monday.setUTCHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: dates[6],
    dates,
  };
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CORE_ROLE_ID = process.env.CORE_ROLE_ID;
const CONTRIBUTOR_ROLE_ID = process.env.CONTRIBUTOR_ROLE_ID;
const DISCORD_ACTION_WEBHOOK_URL = process.env.DISCORD_ACTION_WEBHOOK_URL || "";

const REQUIRED_COUNT = 3;
const THREAD_SCAN_LIMIT = 100;
const GUILD_ID = process.env.GUILD_ID;
const NOTION_LINK =
  "https://www.notion.so/2de6c15f67fb8039b0f7e6e9c7fe202f?v=2de6c15f67fb815e809d000ce19fbfe7";

function truncateForDiscord(value, max = 900) {
  const text = String(value || "").trim();
  if (!text || text === "-") return "없음";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function actionField(name, value, inline = false) {
  return {
    name,
    value: truncateForDiscord(value, inline ? 240 : 900),
    inline,
  };
}

const ACTION_ALERT_STYLES = [
  [/체크인 등록/, { icon: "✅", color: 0x2ecc71, label: "Check-in" }],
  [/체크인 삭제/, { icon: "🧹", color: 0xe74c3c, label: "Check-in" }],
  [/체크인|작업 시간/, { icon: "🕒", color: 0xf1c40f, label: "Check-in" }],
  [/버그/, { icon: "🛠️", color: 0xe67e22, label: "Bug Queue" }],
  [/공지/, { icon: "📣", color: 0x3498db, label: "Notice" }],
  [/팀원|멤버/, { icon: "👤", color: 0x9b59b6, label: "People" }],
  [/바로가기/, { icon: "🔗", color: 0x1abc9c, label: "Quick Link" }],
  [/투표/, { icon: "📊", color: 0x5865f2, label: "Poll" }],
  [/아이디어/, { icon: "💡", color: 0xf1c40f, label: "Idea" }],
  [/메모/, { icon: "📝", color: 0x95a5a6, label: "Memo" }],
  [/Discord/, { icon: "💬", color: 0x5865f2, label: "Discord" }],
];

function getActionAlertStyle(title) {
  return (
    ACTION_ALERT_STYLES.find(([pattern]) => pattern.test(title || ""))?.[1] || {
      icon: "🔔",
      color: 0x5865f2,
      label: "Activity",
    }
  );
}

function emitActionAlert(event) {
  if (!DISCORD_ACTION_WEBHOOK_URL) return;
  const title = event.title || "Admin action";
  const style = getActionAlertStyle(title);
  const fields = (event.fields || [])
    .filter((f) => f && f.name)
    .slice(0, 12)
    .map((f) => actionField(f.name, f.value, Boolean(f.inline)));
  const embed = {
    author: {
      name: `Knockdog Admin · ${style.label}`,
    },
    title: `${style.icon} ${title}`,
    description: truncateForDiscord(event.description || "", 1800),
    color: event.color || style.color,
    timestamp: new Date().toISOString(),
    footer: {
      text: "admin.knockdog.net",
    },
  };
  if (fields.length) embed.fields = fields;
  const payload = {
    username: "Knockdog Admin",
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
  fetch(DISCORD_ACTION_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn("Discord action alert failed:", err.message);
  });
}

function validateConfig() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!FORUM_CHANNEL_ID) missing.push("FORUM_CHANNEL_ID");
  if (!REPORT_CHANNEL_ID) missing.push("REPORT_CHANNEL_ID");
  if (!CORE_ROLE_ID) missing.push("CORE_ROLE_ID");
  return missing;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function getWeekKey(offsetWeeks = 0) {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  kst.setDate(kst.getDate() - offsetWeeks * 7);
  const monday = new Date(kst);
  monday.setDate(kst.getDate() - ((kst.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function getWeekKeyFromDate(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const monday = new Date(kst);
  monday.setDate(kst.getDate() - ((kst.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function parseThreadTitle(title) {
  const match = title.match(/^\[(\d{4}-\d{2}-\d{2}) \/ (.+)\]$/);
  if (!match) return null;
  return { dayKey: match[1], displayName: match[2].trim() };
}

function extractWorkingTime(content) {
  if (!content) return null;
  
  // Look for Working-time section
  const patterns = [
    /👩🏻‍💻\s*Working-time\s*\n([\d:]+\s*[-~]\s*[\d:]+)/i,
    /Working-time\s*\n([\d:]+\s*[-~]\s*[\d:]+)/i,
    /Working-time[:\s]*([\d:]+\s*[-~]\s*[\d:]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

async function countCoreSyncForWeek(weekKey, memberNameToId = null) {
  const forum = await client.channels.fetch(FORUM_CHANNEL_ID);

  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: THREAD_SCAN_LIMIT });

  const threads = [
    ...active.threads.values(),
    ...archived.threads.values(),
  ];

  const userDays = new Map(); // userId -> Set of dayKeys
  const userWorkingTimes = new Map(); // userId -> Map of dayKey -> workingTime

  for (const thread of threads) {
    const parsed = parseThreadTitle(thread.name);
    if (!parsed) continue;

    const date = new Date(parsed.dayKey);
    if (getWeekKeyFromDate(date) !== weekKey) continue;

    // Try to get userId from ownerId first, then from displayName in thread title
    let userId = thread.ownerId;
    
    // If thread was created by bot (or we have name mapping), try to match by displayName
    if (parsed.displayName && memberNameToId) {
      const mappedId = memberNameToId.get(parsed.displayName.toLowerCase());
      if (mappedId) {
        userId = mappedId;
      }
    }
    
    if (!userId) continue;

    if (!userDays.has(userId)) {
      userDays.set(userId, new Set());
      userWorkingTimes.set(userId, new Map());
    }

    userDays.get(userId).add(parsed.dayKey);

    // Fetch first message to get working time
    try {
      const messages = await thread.messages.fetch({ limit: 1 });
      const firstMessage = messages.first();
      if (firstMessage) {
        const workingTime = extractWorkingTime(firstMessage.content);
        if (workingTime) {
          userWorkingTimes.get(userId).set(parsed.dayKey, workingTime);
        }
      }
    } catch (err) {
      console.error(`Error fetching message from thread ${thread.id}:`, err.message);
    }
  }

  return { userDays, userWorkingTimes };
}

async function getGuild() {
  if (GUILD_ID) {
    return await client.guilds.fetch(GUILD_ID).catch(() => null);
  }
  return client.guilds.cache.first();
}

let membersFetchedAt = 0;
const MEMBERS_CACHE_TTL = 60000;

async function fetchMembersWithCache(guild) {
  const now = Date.now();
  if (now - membersFetchedAt > MEMBERS_CACHE_TTL) {
    try {
      await guild.members.fetch();
      membersFetchedAt = now;
    } catch (err) {
      console.warn("멤버 목록 갱신 실패, 캐시 사용:", err.message);
    }
  }
}

async function getMembersDataByRole(weekKey) {
  const guild = await getGuild();
  if (!guild) {
    throw new Error("서버를 찾을 수 없습니다. GUILD_ID를 설정해주세요.");
  }

  await fetchMembersWithCache(guild);

  const coreMembers = guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CORE_ROLE_ID)
  );

  const contributorMembers = CONTRIBUTOR_ROLE_ID ? guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CONTRIBUTOR_ROLE_ID) && !m.roles.cache.has(CORE_ROLE_ID)
  ) : new Map();

  // Build name-to-id mapping for matching bot-posted threads
  const memberNameToId = new Map();
  for (const member of [...coreMembers.values(), ...contributorMembers.values()]) {
    memberNameToId.set(member.displayName.toLowerCase(), member.id);
  }

  const { userDays, userWorkingTimes } = await countCoreSyncForWeek(weekKey, memberNameToId);

  function buildMemberData(members) {
    const membersData = [];
    for (const member of members.values()) {
      const count = userDays.get(member.id)?.size ?? 0;
      const days = userDays.get(member.id) ? Array.from(userDays.get(member.id)) : [];
      const workingTimes = userWorkingTimes.get(member.id) 
        ? Object.fromEntries(userWorkingTimes.get(member.id)) 
        : {};

      membersData.push({
        id: member.id,
        displayName: member.displayName,
        username: member.user.username,
        avatar: member.user.displayAvatarURL({ size: 64 }),
        syncCount: count,
        requiredCount: REQUIRED_COUNT,
        percentage: Math.round((count / REQUIRED_COUNT) * 100),
        isMet: count >= REQUIRED_COUNT,
        days: days.sort(),
        workingTimes: workingTimes,
      });
    }
    membersData.sort((a, b) => b.syncCount - a.syncCount);
    return membersData;
  }

  return {
    coreMembers: buildMemberData(coreMembers),
    contributorMembers: buildMemberData(contributorMembers)
  };
}

async function getAllMembersForDM() {
  const guild = await getGuild();
  if (!guild) return [];

  await fetchMembersWithCache(guild);

  const allMembers = guild.members.cache.filter(
    (m) => !m.user.bot && (m.roles.cache.has(CORE_ROLE_ID) || (CONTRIBUTOR_ROLE_ID && m.roles.cache.has(CONTRIBUTOR_ROLE_ID)))
  );

  return Array.from(allMembers.values());
}

async function generateReport() {
  const missingConfig = validateConfig();
  if (missingConfig.length > 0) {
    console.error("설정 오류:", missingConfig.join(", "));
    return null;
  }

  const weekKey = getWeekKey();

  const guild = await getGuild();
  if (!guild) {
    console.error("서버를 찾을 수 없습니다. GUILD_ID를 확인해주세요.");
    return null;
  }

  await fetchMembersWithCache(guild);

  const coreMembers = guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CORE_ROLE_ID)
  );

  // Build name-to-id mapping for matching bot-posted threads
  const memberNameToId = new Map();
  for (const member of coreMembers.values()) {
    memberNameToId.set(member.displayName.toLowerCase(), member.id);
  }

  const { userDays } = await countCoreSyncForWeek(weekKey, memberNameToId);

  const lines = [];
  const underperformed = [];

  for (const member of coreMembers.values()) {
    const count = userDays.get(member.id)?.size ?? 0;
    lines.push(`- ${member.displayName}: ${count} / ${REQUIRED_COUNT}`);
    if (count < REQUIRED_COUNT) {
      underperformed.push(`<@${member.id}>`);
    }
  }

  return [
    `Core Sync Report (${weekKey} 주차)`,
    ``,
    ...lines,
    ``,
    underperformed.length
      ? `기준 미달: ${underperformed.join(" ")}`
      : `모든 Core 멤버가 기준을 충족했습니다.`,
    ``,
    `📌 Core Sync 기준 & 가이드`,
    NOTION_LINK,
  ].join("\n");
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/members", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, COALESCE(team, '') AS team FROM team_members WHERE archived = FALSE ORDER BY team NULLS LAST, id`
    );
    res.json({
      members: result.rows.map((r) => r.name),
      membersData: result.rows.map((r) => ({ name: r.name, team: r.team || "" })),
    });
  } catch (err) {
    console.error("Members GET error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/members", async (req, res) => {
  try {
    const name = (req.body?.name || "").trim().normalize("NFC");
    const team = (req.body?.team || "").trim().normalize("NFC");
    if (!name) return res.status(400).json({ error: "name required" });
    if (name.length > 100) {
      return res.status(400).json({ error: "이름이 너무 깁니다 (100자 제한)" });
    }
    if (team.length > 50) {
      return res.status(400).json({ error: "팀 이름이 너무 깁니다 (50자 제한)" });
    }
    await pool.query(
      `INSERT INTO team_members (name, team) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET archived = FALSE, team = COALESCE(NULLIF($2, ''), team_members.team)`,
      [name, team]
    );
    emitActionAlert({
      title: "팀원 추가/복원",
      description: `${name} 님이 팀원 목록에 추가되거나 복원되었습니다.`,
      fields: [
        { name: "이름", value: name, inline: true },
        { name: "팀", value: team || "-", inline: true },
      ],
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Members POST error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/members/:name", async (req, res) => {
  // Normalize incoming Korean text to NFC. macOS clipboard / Finder often produces
  // NFD which byte-mismatches NFC stored rows, which then makes UPDATE silently
  // hit 0 rows and the caller thinks nothing happened.
  const oldNameRaw = decodeURIComponent(req.params.name || "").trim();
  const oldName = oldNameRaw.normalize("NFC");
  const body = req.body || {};
  const hasNewName = typeof body.name === "string";
  const hasTeam = typeof body.team === "string";
  const newName = hasNewName ? body.name.trim().normalize("NFC") : oldName;
  const newTeam = hasTeam ? body.team.trim().normalize("NFC") : null;
  if (!oldName) {
    return res.status(400).json({ error: "name required" });
  }
  if (hasNewName && !newName) {
    return res.status(400).json({ error: "name cannot be empty" });
  }
  if (newName.length > 100) {
    return res.status(400).json({ error: "이름이 너무 깁니다 (100자 제한)" });
  }
  if (newTeam !== null && newTeam.length > 50) {
    return res.status(400).json({ error: "팀 이름이 너무 깁니다 (50자 제한)" });
  }
  const isRename = newName !== oldName;
  if (!isRename && newTeam === null) {
    return res.json({ success: true, unchanged: true });
  }

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Resolve the actual DB row whose name matches oldName, allowing for NFC/NFD
    // and whitespace drift between the URL param and the stored value.
    const all = await c.query(`SELECT name FROM team_members`);
    const matched = all.rows
      .map((r) => r.name)
      .find((n) =>
        n === oldName ||
        n === oldNameRaw ||
        (typeof n === "string" && n.normalize("NFC") === oldName)
      );
    if (!matched) {
      await c.query("ROLLBACK");
      return res.status(404).json({
        error: `'${oldName}' 팀원을 찾을 수 없어요. 목록을 새로고침 후 다시 시도해주세요.`,
        code: "MEMBER_NOT_FOUND",
      });
    }
    const dbOldName = matched; // exact bytes stored in DB

    if (isRename) {
      const conflict = await c.query(
        `SELECT id FROM team_members WHERE name = $1 AND name <> $2`,
        [newName, dbOldName]
      );
      if (conflict.rows.length) {
        await c.query("ROLLBACK");
        return res.status(409).json({
          error: `이미 '${newName}' 팀원이 있어요. 다른 이름을 써주세요.`,
          code: "MEMBER_NAME_CONFLICT",
        });
      }
      const upd = await c.query(
        `UPDATE team_members SET name = $1 WHERE name = $2`,
        [newName, dbOldName]
      );
      if (upd.rowCount === 0) {
        await c.query("ROLLBACK");
        return res.status(500).json({
          error: "rename failed (0 rows affected)",
          code: "MEMBER_RENAME_NO_ROWS",
        });
      }
    }
    if (newTeam !== null) {
      await c.query(
        `UPDATE team_members SET team = $1 WHERE name = $2`,
        [newTeam, newName]
      );
    }
    if (!isRename) {
      await c.query("COMMIT");
      emitActionAlert({
        title: "팀원 정보 수정",
        description: `${dbOldName} 님의 팀 정보가 수정되었습니다.`,
        fields: [
          { name: "이름", value: dbOldName, inline: true },
          { name: "팀", value: newTeam || "-", inline: true },
        ],
      });
      return res.json({ success: true, oldName: dbOldName, newName, team: newTeam });
    }
    await c.query(
      `UPDATE checkins SET user_name = $1 WHERE user_name = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE announcement_reads SET user_name = $1 WHERE user_name = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE idea_likes SET user_name = $1 WHERE user_name = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE ideas SET author = $1 WHERE author = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE memos SET author = $1 WHERE author = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE polls SET created_by = $1 WHERE created_by = $2`,
      [newName, dbOldName]
    );
    await c.query(
      `UPDATE votes SET voter_name = $1 WHERE voter_name = $2`,
      [newName, dbOldName]
    );
    await c.query("COMMIT");
    emitActionAlert({
      title: "팀원 이름 변경",
      description: `${dbOldName} → ${newName}`,
      fields: [
        { name: "기존 이름", value: dbOldName, inline: true },
        { name: "새 이름", value: newName, inline: true },
        { name: "팀", value: newTeam || "-", inline: true },
      ],
    });
    res.json({ success: true, oldName: dbOldName, newName, team: newTeam });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("Members PATCH error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

app.delete("/api/members/:name", async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    await pool.query(
      `UPDATE team_members SET archived = TRUE WHERE name = $1`,
      [name]
    );
    emitActionAlert({
      title: "팀원 아카이브",
      description: `${name} 님이 팀원 목록에서 숨김 처리되었습니다.`,
      fields: [{ name: "이름", value: name, inline: true }],
      color: 0xf1c40f,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Members DELETE error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/checkin", async (req, res) => {
  try {
    const {
      userName,
      checkDate,
      startTime,
      endTime,
      done,
      tasks,
      blockers,
      linkUrl,
    } = req.body || {};

    // Normalize done/tasks items (accept legacy string or new array shape).
    const doneItems = normalizeItems(done);
    const taskItems = normalizeItems(tasks);
    const doneRaw =
      doneItems !== undefined ? itemsToStorage(doneItems) : undefined;
    const tasksRaw =
      taskItems !== undefined ? itemsToStorage(taskItems) : undefined;

    if (!userName) {
      return res.status(400).json({ error: "userName required" });
    }

    let date = todayKST();
    if (checkDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkDate)) {
        return res.status(400).json({ error: "checkDate must be YYYY-MM-DD" });
      }
      date = checkDate;
    }

    const fields = {
      start_time: startTime,
      end_time: endTime,
      done: doneRaw,
      tasks: tasksRaw,
      blockers,
      link_url: linkUrl,
    };
    const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (!provided.length) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const isCheckinWrite =
      done !== undefined || tasks !== undefined || blockers !== undefined;
    if (isCheckinWrite && date !== todayKST()) {
      return res
        .status(400)
        .json({ error: "체크인은 오늘 날짜에만 가능합니다" });
    }

    const hasCheckinContent =
      (doneItems && doneItems.length > 0) ||
      (taskItems && taskItems.length > 0) ||
      (typeof blockers === "string" && blockers.trim() !== "");

    if (isCheckinWrite && hasCheckinContent) {
      const hours = await pool.query(
        `SELECT start_time, end_time, hours_text, unavailable_text
           FROM checkins
          WHERE check_date = $1 AND user_name = $2`,
        [date, userName]
      );
      const h = hours.rows[0];
      const hasWorkHours =
        h &&
        (h.hours_text || "").trim() &&
        dailyMinutes(h.start_time, h.end_time, h.unavailable_text) !== null;
      if (!hasWorkHours) {
        return res.status(400).json({
          error: "이번 주 작업 시간을 먼저 저장해야 체크인할 수 있어요.",
          code: "WEEK_HOURS_REQUIRED",
        });
      }
    }

    const beforeResult = await pool.query(
      `SELECT start_time, end_time, done, tasks, blockers, link_url
         FROM checkins
        WHERE check_date = $1 AND user_name = $2`,
      [date, userName]
    );
    const before = beforeResult.rows[0] || null;
    const beforeHadContent = Boolean(
      before &&
        ((before.done || "").trim() ||
          (before.tasks || "").trim() ||
          (before.blockers || "").trim())
    );

    await pool.query(
      `INSERT INTO checkins (check_date, user_name)
       VALUES ($1, $2)
       ON CONFLICT (check_date, user_name) DO NOTHING`,
      [date, userName]
    );

    const setClause = provided
      .map(([col], i) => `${col} = $${i + 3}`)
      .join(", ");
    const params = [date, userName, ...provided.map(([, v]) => v)];
    await pool.query(
      `UPDATE checkins SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE check_date = $1 AND user_name = $2`,
      params
    );

    if (isCheckinWrite) {
      if (hasCheckinContent) {
        await pool.query(
          `UPDATE checkins SET checked_in_at = COALESCE(checked_in_at, $3)
           WHERE check_date = $1 AND user_name = $2`,
          [date, userName, nowHHMMKST()]
        );
      } else {
        await pool.query(
          `UPDATE checkins SET checked_in_at = NULL
           WHERE check_date = $1 AND user_name = $2`,
          [date, userName]
        );
      }
    }

    const result = await pool.query(
      `SELECT start_time, end_time, done, tasks, blockers, updated_at, checked_in_at, link_url
       FROM checkins WHERE check_date = $1 AND user_name = $2`,
      [date, userName]
    );
    const r = result.rows[0] || {};
    const doneRows = itemsFromStorage(r.done, r.link_url);
    const tasksRows = itemsFromStorage(r.tasks, "");
    const afterHadContent = Boolean(
      (r.done || "").trim() || (r.tasks || "").trim() || (r.blockers || "").trim()
    );
    let alertTitle = "체크인 수정";
    let alertDescription = `${userName} 님이 ${date} 체크인 내용을 업데이트했습니다.`;
    let alertColor = 0x5865f2;
    if (isCheckinWrite && afterHadContent && !beforeHadContent) {
      alertTitle = "체크인 등록";
      alertDescription = `${userName} 님이 오늘 체크인을 남겼습니다.`;
      alertColor = 0x2ecc71;
    } else if (isCheckinWrite && !afterHadContent && beforeHadContent) {
      alertTitle = "체크인 삭제";
      alertDescription = `${userName} 님이 ${date} 체크인 내용을 비웠습니다.`;
      alertColor = 0xe74c3c;
    } else if (!isCheckinWrite) {
      alertTitle = "체크인 시간 수정";
      alertDescription = `${userName} 님의 ${date} 근무 시간이 수정되었습니다.`;
      alertColor = 0xf1c40f;
    }
    emitActionAlert({
      title: alertTitle,
      description: alertDescription,
      color: alertColor,
      fields: [
        { name: "작성자", value: userName, inline: true },
        { name: "날짜", value: date, inline: true },
        { name: "근무 시간", value: `${r.start_time || "-"} ~ ${r.end_time || "-"}`, inline: true },
        { name: "체크인 시각", value: r.checked_in_at || "-", inline: true },
        { name: "완료한 일", value: itemsFlatText(doneRows) || "-" },
        { name: "다음 할 일", value: itemsFlatText(tasksRows) || "-" },
        { name: "블로커", value: r.blockers || "-" },
      ],
    });
    res.json({
      success: true,
      checkDate: date,
      checkin: {
        userName,
        startTime: r.start_time || "",
        endTime: r.end_time || "",
        doneItems: doneRows,
        tasksItems: tasksRows,
        done: itemsFlatText(doneRows),  // legacy clients
        tasks: itemsFlatText(tasksRows),
        blockers: r.blockers || "",
        updatedAt: r.updated_at,
        checkedInAt: r.checked_in_at || "",
        isLate: isLateCheckin(r.start_time, r.checked_in_at),
        linkUrl: r.link_url || "",
      },
    });
  } catch (err) {
    console.error("Checkin error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/checkin/user", async (req, res) => {
  const clientDb = await pool.connect();
  try {
    const { fromUserName, toUserName, checkDate } = req.body || {};
    const fromName = typeof fromUserName === "string" ? fromUserName.trim() : "";
    const toName = typeof toUserName === "string" ? toUserName.trim() : "";
    if (!fromName || !toName) {
      return res.status(400).json({ error: "fromUserName and toUserName required" });
    }
    if (fromName === toName) {
      return res.json({ success: true, unchanged: true, checkDate: checkDate || todayKST() });
    }

    let date = todayKST();
    if (checkDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkDate)) {
        return res.status(400).json({ error: "checkDate must be YYYY-MM-DD" });
      }
      date = checkDate;
    }
    if (date !== todayKST()) {
      return res.status(400).json({ error: "오늘 체크인만 이름을 변경할 수 있습니다" });
    }

    await clientDb.query("BEGIN");
    const existing = await clientDb.query(
      `SELECT *
         FROM checkins
        WHERE check_date = $1 AND user_name = $2
        FOR UPDATE`,
      [date, fromName]
    );
    if (!existing.rows.length) {
      await clientDb.query("ROLLBACK");
      return res.status(404).json({ error: "checkin not found" });
    }
    const source = existing.rows[0];

    const conflict = await clientDb.query(
      `SELECT *
         FROM checkins
        WHERE check_date = $1 AND user_name = $2
        FOR UPDATE`,
      [date, toName]
    );
    if (conflict.rows.length) {
      const target = conflict.rows[0];
      const targetHasCheckin =
        (target.done || "").trim() ||
        (target.tasks || "").trim() ||
        (target.blockers || "").trim();
      if (targetHasCheckin) {
        await clientDb.query("ROLLBACK");
        return res.status(409).json({
          error: `${toName} 님의 오늘 체크인이 이미 있어요. 먼저 대상 체크인을 정리한 뒤 다시 시도해주세요.`,
          code: "CHECKIN_USER_EXISTS",
        });
      }
      await clientDb.query(
        `UPDATE checkins
            SET done = $1,
                tasks = $2,
                blockers = $3,
                link_url = $4,
                checked_in_at = $5,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $6`,
        [
          source.done || "",
          source.tasks || "",
          source.blockers || "",
          source.link_url || "",
          source.checked_in_at || null,
          target.id,
        ]
      );
      await clientDb.query(
        `UPDATE checkins
            SET done = '',
                tasks = '',
                blockers = '',
                link_url = '',
                checked_in_at = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [source.id]
      );
    } else {
      await clientDb.query(
        `UPDATE checkins
            SET user_name = $1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [toName, source.id]
      );
    }
    await clientDb.query("COMMIT");
    emitActionAlert({
      title: "체크인 작성자 변경",
      description: `${fromName} 님의 ${date} 체크인이 ${toName} 님에게 이동되었습니다.`,
      fields: [
        { name: "날짜", value: date, inline: true },
        { name: "기존 이름", value: fromName, inline: true },
        { name: "새 이름", value: toName, inline: true },
      ],
      color: 0xf1c40f,
    });
    res.json({ success: true, checkDate: date, fromUserName: fromName, toUserName: toName });
  } catch (err) {
    await clientDb.query("ROLLBACK").catch(() => {});
    console.error("Checkin user rename error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    clientDb.release();
  }
});

app.get("/api/checkin/today", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_name, start_time, end_time, done, tasks, blockers, updated_at, link_url
       FROM checkins
       WHERE check_date = CURRENT_DATE
         AND (COALESCE(done, '') <> '' OR COALESCE(tasks, '') <> '' OR COALESCE(blockers, '') <> '')
       ORDER BY updated_at DESC`
    );
    res.json({
      checkDate: todayKST(),
      checkins: result.rows.map((r) => {
        const doneRows = itemsFromStorage(r.done, r.link_url);
        const tasksRows = itemsFromStorage(r.tasks, "");
        return {
          userName: r.user_name,
          startTime: r.start_time,
          endTime: r.end_time,
          doneItems: doneRows,
          tasksItems: tasksRows,
          done: itemsFlatText(doneRows),
          tasks: itemsFlatText(tasksRows),
          blockers: r.blockers,
          updatedAt: r.updated_at,
          linkUrl: r.link_url || "",
        };
      }),
    });
  } catch (err) {
    console.error("Checkin today error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/checkin/me", async (req, res) => {
  const userName = (req.query.userName || "").toString();
  if (!userName) return res.json({ checkin: null });
  const dateParam = (req.query.date || "").toString();
  const date =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayKST();
  try {
    const result = await pool.query(
      `SELECT user_name, start_time, end_time, done, tasks, blockers, updated_at, checked_in_at, link_url
       FROM checkins WHERE check_date = $1 AND user_name = $2`,
      [date, userName]
    );
    if (!result.rows.length) return res.json({ checkin: null, checkDate: date });
    const r = result.rows[0];
    const doneRows = itemsFromStorage(r.done, r.link_url);
    const tasksRows = itemsFromStorage(r.tasks, "");
    res.json({
      checkDate: date,
      checkin: {
        userName: r.user_name,
        startTime: r.start_time,
        endTime: r.end_time,
        doneItems: doneRows,
        tasksItems: tasksRows,
        done: itemsFlatText(doneRows),
        tasks: itemsFlatText(tasksRows),
        blockers: r.blockers,
        updatedAt: r.updated_at,
        checkedInAt: r.checked_in_at || "",
        isLate: isLateCheckin(r.start_time, r.checked_in_at),
        linkUrl: r.link_url || "",
      },
    });
  } catch (err) {
    console.error("Checkin me error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const FREEFORM_RANGE_RE = /(\d{1,2})(?::(\d{2}))?\s*[-~–—]\s*(\d{1,2})(?::(\d{2}))?/;
function parseRangeFromText(text) {
  if (!text) return { start: null, end: null };
  const m = text.match(FREEFORM_RANGE_RE);
  if (!m) return { start: null, end: null };
  const sh = Number(m[1]);
  const sm = Number(m[2] || 0);
  const eh = Number(m[3]);
  const em = Number(m[4] || 0);
  if (sh > 24 || eh > 24 || sm > 59 || em > 59) return { start: null, end: null };
  const pad = (n) => String(n).padStart(2, "0");
  return { start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh)}:${pad(em)}` };
}

app.post("/api/checkin/week-hours", async (req, res) => {
  try {
    const { userName, hours } = req.body || {};
    if (!userName) return res.status(400).json({ error: "userName required" });
    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours must be an array" });
    }
    for (const h of hours) {
      if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
        return res
          .status(400)
          .json({ error: `invalid date: ${h.date}` });
      }
    }

    // Weekday all-or-nothing rule: after this save, every affected week's
    // Mon–Fri must be uniformly all-filled (5/5) or all-empty (0/5).
    {
      const weeksTouched = new Set();
      for (const h of hours) weeksTouched.add(mondayOfISO(h.date));
      for (const monday of weeksTouched) {
        const weekdayDates = [0, 1, 2, 3, 4].map((i) => addDaysISO(monday, i));
        const existing = await pool.query(
          `SELECT check_date, hours_text FROM checkins
           WHERE user_name = $1 AND check_date = ANY($2::date[])`,
          [userName, weekdayDates]
        );
        const existingMap = new Map();
        for (const row of existing.rows) {
          const ds =
            row.check_date instanceof Date
              ? row.check_date.toISOString().slice(0, 10)
              : String(row.check_date).slice(0, 10);
          existingMap.set(ds, (row.hours_text || "").trim());
        }
        const reqMap = new Map();
        for (const h of hours) {
          if (weekdayDates.includes(h.date)) {
            reqMap.set(h.date, (h.text || "").trim());
          }
        }
        const effective = weekdayDates.map((d) =>
          reqMap.has(d) ? reqMap.get(d) : existingMap.get(d) || ""
        );
        const filledCount = effective.filter((v) => v).length;
        if (filledCount > 0 && filledCount < 5) {
          const missing = weekdayDates.filter((_, i) => !effective[i]);
          return res.status(400).json({
            error: `평일(월–금)은 한꺼번에 다 입력해야 합니다. 빠진 날짜: ${missing.join(", ")}`,
            code: "WEEKDAY_REQUIRED",
            weekStart: monday,
            missing,
          });
        }
      }
    }

    const todayStr = todayKST();
    const todayInputs = hours.filter((h) => h.date === todayStr);
    if (todayInputs.length) {
      const existing = await pool.query(
        `SELECT start_time FROM checkins WHERE check_date = $1 AND user_name = $2`,
        [todayStr, userName]
      );
      const oldStart = existing.rows[0] && existing.rows[0].start_time;
      const oldStartMin = hhmmToMin(oldStart);
      if (oldStartMin !== null) {
        const oldCutoff = oldStartMin + CHECKIN_GRACE_MIN;
        if (nowMinKST() > oldCutoff) {
          for (const h of todayInputs) {
            const parsed = parseRangeFromText((h.text || "").trim());
            const newStartMin = hhmmToMin(parsed.start);
            if (newStartMin !== null && newStartMin > oldStartMin) {
              return res.status(403).json({
                error:
                  `오늘 체크인 마감(${minToHHMM(oldCutoff)})이 이미 지나서 시작 시간을 더 늦출 수 없어요. (기존 ${oldStart} → ${parsed.start}) 더 이른 시간으로만 조정 가능합니다.`,
                code: "START_TIME_LOCKED",
                oldStart,
                newStart: parsed.start,
                cutoffTime: minToHHMM(oldCutoff),
              });
            }
          }
        }
      }
    }

    for (const h of hours) {
      const text = (h.text || "").trim();
      const unavailable = (h.unavailable || "").trim();
      const parsed = parseRangeFromText(text);
      await pool.query(
        `INSERT INTO checkins (check_date, user_name, hours_text, unavailable_text, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (check_date, user_name) DO UPDATE SET
           hours_text = EXCLUDED.hours_text,
           unavailable_text = EXCLUDED.unavailable_text,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           updated_at = CURRENT_TIMESTAMP`,
        [h.date, userName, text, unavailable, parsed.start, parsed.end]
      );
    }
    emitActionAlert({
      title: "주간 작업 시간 저장",
      description: `${userName} 님의 작업 시간이 저장되었습니다.`,
      fields: [
        { name: "이름", value: userName, inline: true },
        { name: "저장 건수", value: String(hours.length), inline: true },
        {
          name: "날짜/시간",
          value: hours
            .map((h) => {
              const unavailable = (h.unavailable || "").trim();
              return `${h.date}: ${(h.text || "").trim() || "-"}${unavailable ? ` / 불가 ${unavailable}` : ""}`;
            })
            .join("\n"),
        },
      ],
      color: 0xf1c40f,
    });
    res.json({ success: true, saved: hours.length });
  } catch (err) {
    console.error("Week hours error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/checkin/week", async (req, res) => {
  const { weekStart, weekEnd, dates } = getWeekRange(req.query.weekStart);
  try {
    const result = await pool.query(
      `SELECT user_name, check_date, start_time, end_time, hours_text, unavailable_text, checked_in_at,
              (COALESCE(done,'') <> '' OR COALESCE(tasks,'') <> '' OR COALESCE(blockers,'') <> '') AS has_checkin
       FROM checkins
       WHERE check_date BETWEEN $1 AND $2
       ORDER BY user_name, check_date`,
      [weekStart, weekEnd]
    );
    const byUser = new Map();
    for (const row of result.rows) {
      const dateStr =
        row.check_date instanceof Date
          ? row.check_date.toISOString().slice(0, 10)
          : String(row.check_date).slice(0, 10);
      if (!byUser.has(row.user_name)) byUser.set(row.user_name, []);
      const isLate =
        row.has_checkin &&
        isLateCheckin(row.start_time, row.checked_in_at);
      byUser.get(row.user_name).push({
        date: dateStr,
        startTime: row.start_time,
        endTime: row.end_time,
        hoursText: row.hours_text,
        unavailableText: row.unavailable_text || "",
        hasCheckin: row.has_checkin,
        checkedInAt: row.checked_in_at || "",
        isLate,
        dailyMin: dailyMinutes(row.start_time, row.end_time, row.unavailable_text),
      });
    }
    const users = [...byUser.entries()]
      .map(([userName, entries]) => ({ userName, entries }))
      .sort((a, b) => b.entries.length - a.entries.length);
    res.json({ weekStart, weekEnd, dates, users });
  } catch (err) {
    console.error("Checkin week error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sync-data", async (req, res) => {
  try {
    const weekOffset = parseInt(req.query.weekOffset) || 0;
    const weekKey = getWeekKey(weekOffset);
    const missingConfig = validateConfig();

    if (!client.isReady()) {
      return res.json({
        success: true,
        weekKey,
        requiredCount: REQUIRED_COUNT,
        members: [],
        botConnected: false,
        configStatus: missingConfig.length > 0 ? `환경변수 누락: ${missingConfig.join(", ")}` : "설정 완료",
        missingConfig,
      });
    }

    const { coreMembers, contributorMembers } = await getMembersDataByRole(weekKey);

    // Generate week days (Monday to Sunday)
    const weekStart = new Date(weekKey);
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + i);
      weekDays.push(day.toISOString().slice(0, 10));
    }

    res.json({
      success: true,
      weekKey,
      weekDays,
      requiredCount: REQUIRED_COUNT,
      members: coreMembers,
      contributorMembers: contributorMembers,
      botConnected: true,
      configStatus: "설정 완료",
      missingConfig: [],
    });
  } catch (error) {
    console.error("API Error:", error);
    const weekOffset = parseInt(req.query.weekOffset) || 0;
    res.status(500).json({
      success: false,
      weekKey: getWeekKey(weekOffset),
      error: error.message,
      botConnected: client.isReady(),
      configStatus: validateConfig().length > 0 ? `환경변수 누락: ${validateConfig().join(", ")}` : "설정 완료",
    });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    botConnected: client.isReady(),
    botUser: client.user ? client.user.tag : null,
    guilds: client.guilds.cache.size,
  });
});

// Memo API endpoints
app.get("/api/memos", async (req, res) => {
  try {
    const weekKey = req.query.weekKey;
    if (!weekKey) {
      return res.status(400).json({ error: "weekKey required" });
    }
    const result = await pool.query(
      "SELECT * FROM memos WHERE week_key = $1 ORDER BY created_at DESC",
      [weekKey]
    );
    res.json({ success: true, memos: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/memos", async (req, res) => {
  try {
    const { weekKey, content, color, author } = req.body;
    if (!weekKey || !content) {
      return res.status(400).json({ error: "weekKey and content required" });
    }
    const result = await pool.query(
      "INSERT INTO memos (week_key, content, color, author) VALUES ($1, $2, $3, $4) RETURNING *",
      [weekKey, content, color || "yellow", author || "Anonymous"]
    );
    emitActionAlert({
      title: "메모 작성",
      description: `${author || "Anonymous"} 님이 ${weekKey} 주차 메모를 작성했습니다.`,
      fields: [
        { name: "주차", value: weekKey, inline: true },
        { name: "작성자", value: author || "Anonymous", inline: true },
        { name: "내용", value: content },
      ],
    });
    res.json({ success: true, memo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/memos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM memos WHERE id = $1", [id]);
    emitActionAlert({
      title: "메모 삭제",
      description: `메모 #${id}가 삭제되었습니다.`,
      fields: [{ name: "ID", value: id, inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Announcement API endpoints
app.get("/api/announcements", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM announcements WHERE is_active = true ORDER BY created_at DESC"
    );
    const announcements = result.rows;
    for (const ann of announcements) {
      const reads = await pool.query(
        "SELECT user_name, created_at FROM announcement_reads WHERE announcement_id = $1 ORDER BY created_at",
        [ann.id]
      );
      ann.readers = reads.rows;
    }
    res.json({ success: true, announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/announcements", async (req, res) => {
  try {
    const { content, sendDM } = req.body;
    if (!content) {
      return res.status(400).json({ error: "content required" });
    }
    const result = await pool.query(
      "INSERT INTO announcements (content) VALUES ($1) RETURNING *",
      [content]
    );

    let dmResults = { sent: 0, failed: 0 };
    if (sendDM && client.isReady()) {
      const members = await getAllMembersForDM();
      const dmMessage = `📢 **새로운 공지사항**\n\n${content}\n\n---\n_Knockdog Admin에서 발송됨_`;
      
      for (const member of members) {
        try {
          await member.user.send(dmMessage);
          dmResults.sent++;
        } catch (dmErr) {
          console.log(`DM failed for ${member.displayName}:`, dmErr.message);
          dmResults.failed++;
        }
      }
    }

    emitActionAlert({
      title: "공지 작성",
      description: "새 공지가 등록되었습니다.",
      fields: [
        { name: "내용", value: content },
        { name: "DM", value: sendDM ? `${dmResults.sent} sent / ${dmResults.failed} failed` : "미발송", inline: true },
      ],
    });
    res.json({ success: true, announcement: result.rows[0], dmResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content required" });
    }
    const result = await pool.query(
      "UPDATE announcements SET content = $1 WHERE id = $2 AND is_active = true RETURNING *",
      [content.trim(), id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "announcement not found" });
    }
    emitActionAlert({
      title: "공지 수정",
      description: `공지 #${id}가 수정되었습니다.`,
      fields: [
        { name: "ID", value: id, inline: true },
        { name: "내용", value: content.trim() },
      ],
      color: 0xf1c40f,
    });
    res.json({ success: true, announcement: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE announcements SET is_active = false WHERE id = $1", [id]);
    emitActionAlert({
      title: "공지 삭제",
      description: `공지 #${id}가 비활성화되었습니다.`,
      fields: [{ name: "ID", value: id, inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/announcements/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    const { userName } = req.body;
    if (!userName) {
      return res.status(400).json({ error: "userName required" });
    }
    await pool.query(`
      INSERT INTO announcement_reads (announcement_id, user_name)
      VALUES ($1, $2)
      ON CONFLICT (announcement_id, user_name) DO NOTHING
    `, [id, userName]);
    emitActionAlert({
      title: "공지 확인",
      description: `${userName} 님이 공지 #${id}를 확인했습니다.`,
      fields: [
        { name: "공지 ID", value: id, inline: true },
        { name: "이름", value: userName, inline: true },
      ],
    });
    const reads = await pool.query(
      "SELECT user_name, created_at FROM announcement_reads WHERE announcement_id = $1 ORDER BY created_at",
      [id]
    );
    res.json({ success: true, readers: reads.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick links (hero shortcuts) CRUD
app.get("/api/quick-links", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, url, icon_url, position FROM quick_links ORDER BY position, id`
    );
    res.json({
      links: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        iconUrl: r.icon_url || "",
        position: r.position,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/quick-links", async (req, res) => {
  try {
    const { name, url, iconUrl } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url required" });
    }
    const posResult = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM quick_links`
    );
    const pos = posResult.rows[0].p;
    const result = await pool.query(
      `INSERT INTO quick_links (name, url, icon_url, position) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), url.trim(), (iconUrl || "").trim(), pos]
    );
    const r = result.rows[0];
    emitActionAlert({
      title: "바로가기 추가",
      description: `${r.name} 링크가 추가되었습니다.`,
      fields: [
        { name: "이름", value: r.name, inline: true },
        { name: "URL", value: r.url },
      ],
    });
    res.json({
      success: true,
      link: { id: r.id, name: r.name, url: r.url, iconUrl: r.icon_url || "", position: r.position },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/quick-links/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const { name, url, iconUrl } = req.body || {};
    const sets = [];
    const params = [];
    if (typeof name === "string") {
      if (!name.trim()) return res.status(400).json({ error: "name cannot be empty" });
      params.push(name.trim()); sets.push(`name = $${params.length}`);
    }
    if (typeof url === "string") {
      if (!url.trim()) return res.status(400).json({ error: "url cannot be empty" });
      params.push(url.trim()); sets.push(`url = $${params.length}`);
    }
    if (typeof iconUrl === "string") {
      params.push(iconUrl.trim()); sets.push(`icon_url = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "no fields to update" });
    params.push(id);
    const result = await pool.query(
      `UPDATE quick_links SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: "not found" });
    const r = result.rows[0];
    emitActionAlert({
      title: "바로가기 수정",
      description: `${r.name} 링크가 수정되었습니다.`,
      fields: [
        { name: "ID", value: String(r.id), inline: true },
        { name: "이름", value: r.name, inline: true },
        { name: "URL", value: r.url },
      ],
      color: 0xf1c40f,
    });
    res.json({
      success: true,
      link: { id: r.id, name: r.name, url: r.url, iconUrl: r.icon_url || "", position: r.position },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/quick-links/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    await pool.query(`DELETE FROM quick_links WHERE id = $1`, [id]);
    emitActionAlert({
      title: "바로가기 삭제",
      description: `바로가기 #${id}가 삭제되었습니다.`,
      fields: [{ name: "ID", value: String(id), inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bug reports
function mapBugRow(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description || "",
    pageUrl: r.page_url || "",
    reporterName: r.reporter_name || "",
    status: r.status,
    decidedBy: r.decided_by || "",
    decidedAt: r.decided_at,
    decisionNote: r.decision_note || "",
    automationStatus: r.automation_status || "",
    automationUrl: r.automation_url || "",
    automationError: r.automation_error || "",
    createdAt: r.created_at,
  };
}

function bugIssueBody(bug) {
  return [
    "Approved bug report from Knockdog admin.",
    "",
    `Reporter: ${bug.reporter_name || "익명"}`,
    `Page: ${bug.page_url || "-"}`,
    `Approved by: ${bug.decided_by || "-"}`,
    `Approved at: ${bug.decided_at ? new Date(bug.decided_at).toISOString() : "-"}`,
    "",
    "Description:",
    bug.description || "-",
  ].join("\n");
}

async function createGitHubIssueForBug(bug) {
  const repo = process.env.BUG_GITHUB_REPO || process.env.GITHUB_REPOSITORY || "";
  const token = process.env.BUG_GITHUB_TOKEN || process.env.GH_PAT || process.env.GITHUB_TOKEN || "";
  if (!repo || !token) return null;

  const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "daeng-discord-admin",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `[bug] ${bug.title}`,
      body: bugIssueBody(bug),
      labels: ["bug", "admin-approved"],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.message || `GitHub issue create failed (${resp.status})`);
  }
  return data.html_url || data.url || "";
}

async function notifyBugAutomationWebhook(bug, issueUrl) {
  const url = process.env.BUG_AUTOMATION_WEBHOOK_URL || "";
  if (!url) return null;
  const headers = { "Content-Type": "application/json" };
  const token = process.env.BUG_AUTOMATION_WEBHOOK_TOKEN || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event: "bug.approved",
      bug: mapBugRow(bug),
      issueUrl: issueUrl || "",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`automation webhook failed (${resp.status}) ${text.slice(0, 200)}`);
  }
  return "webhook";
}

async function runBugApprovalAutomation(bug) {
  const hasIssueConfig = Boolean(
    (process.env.BUG_GITHUB_REPO || process.env.GITHUB_REPOSITORY) &&
    (process.env.BUG_GITHUB_TOKEN || process.env.GH_PAT || process.env.GITHUB_TOKEN)
  );
  const hasWebhookConfig = Boolean(process.env.BUG_AUTOMATION_WEBHOOK_URL);
  if (!hasIssueConfig && !hasWebhookConfig) {
    return { status: "not_configured", url: "", error: "" };
  }

  const issueUrl = await createGitHubIssueForBug(bug);
  await notifyBugAutomationWebhook(bug, issueUrl);
  return {
    status: issueUrl ? "issue_created" : "webhook_sent",
    url: issueUrl || "",
    error: "",
  };
}

app.get("/api/bugs", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, page_url, reporter_name, status,
              decided_by, decided_at, decision_note,
              automation_status, automation_url, automation_error, created_at
         FROM bug_reports
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
          created_at DESC`
    );
    res.json({
      bugs: result.rows.map(mapBugRow),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bugs", async (req, res) => {
  try {
    const title = ((req.body && req.body.title) || "").trim();
    const description = ((req.body && req.body.description) || "").trim();
    const pageUrl = ((req.body && req.body.pageUrl) || "").trim();
    const reporterName = ((req.body && req.body.reporterName) || "").trim();
    if (!title) return res.status(400).json({ error: "title required" });
    if (title.length > 200) return res.status(400).json({ error: "제목이 너무 깁니다 (200자 제한)" });
    if (pageUrl && !/^https?:\/\//i.test(pageUrl)) {
      return res.status(400).json({ error: "페이지 URL 은 http(s):// 로 시작해야 합니다." });
    }
    const result = await pool.query(
      `INSERT INTO bug_reports (title, description, page_url, reporter_name)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [title, description, pageUrl, reporterName]
    );
    emitActionAlert({
      title: "버그 제보 등록",
      description: title,
      fields: [
        { name: "제보자", value: reporterName || "익명", inline: true },
        { name: "페이지", value: pageUrl || "-", inline: true },
        { name: "설명", value: description || "-" },
      ],
      color: 0xe67e22,
    });
    res.json({
      success: true,
      bug: {
        id: result.rows[0].id,
        title, description, pageUrl, reporterName,
        status: "pending",
        createdAt: result.rows[0].created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/bugs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const body = req.body || {};
    const action = (body.action || "").trim();
    const actor = (body.actor || "").trim();
    const note = (body.note || "").trim();
    let nextStatus;
    if (action === "approve") nextStatus = "approved";
    else if (action === "reject") nextStatus = "rejected";
    else if (action === "resolve") nextStatus = "resolved";
    else if (action === "reopen") nextStatus = "pending";
    else return res.status(400).json({ error: "action must be approve/reject/resolve/reopen" });

    const isReopen = nextStatus === "pending";
    const decidedBy = isReopen ? "" : actor;
    const decidedAt = isReopen ? null : new Date();
    const result = await pool.query(
      `UPDATE bug_reports
          SET status = $1,
              decided_by = $2,
              decided_at = $3,
              decision_note = $4
        WHERE id = $5
        RETURNING *`,
      [nextStatus, decidedBy, decidedAt, note, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "not found" });
    let r = result.rows[0];
    if (action === "approve") {
      let automation;
      try {
        automation = await runBugApprovalAutomation(r);
      } catch (e) {
        automation = { status: "failed", url: "", error: e.message };
      }
      const autoResult = await pool.query(
        `UPDATE bug_reports
            SET automation_status = $1,
                automation_url = $2,
                automation_error = $3
          WHERE id = $4
          RETURNING *`,
        [automation.status, automation.url || "", automation.error || "", id]
      );
      r = autoResult.rows[0] || r;
    }
    emitActionAlert({
      title: "버그 상태 변경",
      description: `#${id} ${r.title}`,
      fields: [
        { name: "액션", value: action, inline: true },
        { name: "상태", value: r.status, inline: true },
        { name: "처리자", value: r.decided_by || actor || "-", inline: true },
        { name: "메모", value: r.decision_note || "-" },
        { name: "자동화", value: r.automation_status || "-", inline: true },
      ],
      color: action === "reject" ? 0xe74c3c : 0x2ecc71,
    });
    res.json({
      success: true,
      bug: mapBugRow(r),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/bugs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    await pool.query(`DELETE FROM bug_reports WHERE id = $1`, [id]);
    emitActionAlert({
      title: "버그 제보 삭제",
      description: `버그 제보 #${id}가 삭제되었습니다.`,
      fields: [{ name: "ID", value: String(id), inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jira API endpoints
app.get("/api/jira/projects", async (req, res) => {
  try {
    const projects = await getProjects();
    res.json({ success: true, projects });
  } catch (err) {
    console.error("Jira projects error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jira/statuses/:projectKey", async (req, res) => {
  try {
    const statuses = await getProjectStatuses(req.params.projectKey);
    res.json({ success: true, statuses });
  } catch (err) {
    console.error("Jira statuses error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jira/assignee-stats", async (req, res) => {
  try {
    const { project, startDate, endDate, statuses } = req.query;
    const options = {};
    
    if (project) options.project = project;
    if (startDate) options.startDate = startDate;
    if (endDate) options.endDate = endDate;
    if (statuses) options.statuses = statuses.split(',');
    
    const stats = await getAssigneeStats(options);
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error("Jira assignee stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get members list for user selection
app.get("/api/members-list", async (req, res) => {
  try {
    if (!client.isReady()) {
      return res.status(503).json({ error: "Bot not connected" });
    }
    
    const guild = await getGuild();
    if (!guild) {
      return res.status(404).json({ error: "Guild not found" });
    }
    
    await fetchMembersWithCache(guild);
    
    const allMembers = guild.members.cache.filter(
      (m) => !m.user.bot && (m.roles.cache.has(CORE_ROLE_ID) || (CONTRIBUTOR_ROLE_ID && m.roles.cache.has(CONTRIBUTOR_ROLE_ID)))
    );
    
    const membersList = Array.from(allMembers.values()).map(m => ({
      id: m.id,
      displayName: m.displayName,
      username: m.user.username,
      avatar: m.user.displayAvatarURL({ size: 64 })
    }));
    
    membersList.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ success: true, members: membersList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get my Jira issues for daily standup
app.get("/api/jira/my-issues", async (req, res) => {
  try {
    const { displayName, project } = req.query;
    if (!displayName) {
      return res.status(400).json({ error: "displayName required" });
    }
    
    const options = {};
    if (project) options.project = project;
    
    const issues = await getMyIssues(displayName, options);
    res.json({ success: true, issues });
  } catch (err) {
    console.error("Jira my-issues error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Post daily standup to Discord forum
app.post("/api/post-daily", async (req, res) => {
  try {
    const { userId, displayName, done, inProgress, blocker, workingTime, date } = req.body;
    
    if (!userId || !displayName) {
      return res.status(400).json({ error: "userId and displayName required" });
    }
    
    if (!client.isReady()) {
      return res.status(503).json({ error: "Bot not connected" });
    }
    
    const forum = await client.channels.fetch(FORUM_CHANNEL_ID);
    if (!forum || forum.type !== 15) {
      return res.status(400).json({ error: "Forum channel not found" });
    }
    
    const postDate = date || new Date().toISOString().slice(0, 10);
    const threadName = `[${postDate} / ${displayName}]`;
    
    let messageContent = '';
    
    if (done && done.length > 0) {
      messageContent += '✅ Done\n';
      messageContent += done.map(item => item).join('\n');
      messageContent += '\n\n';
    }
    
    if (inProgress && inProgress.length > 0) {
      messageContent += '⚒️ In progress\n';
      messageContent += inProgress.map(item => item).join('\n');
      messageContent += '\n\n';
    }
    
    if (blocker) {
      messageContent += '⚠️ Blocker\n';
      messageContent += blocker || '없음';
      messageContent += '\n\n';
    }
    
    if (workingTime) {
      messageContent += '👩🏻‍💻 Working-time\n';
      messageContent += workingTime;
    }
    
    const thread = await forum.threads.create({
      name: threadName,
      message: { content: messageContent.trim() || '오늘의 데일리 업데이트' }
    });
    
    emitActionAlert({
      title: "Discord 데일리 게시",
      description: `${displayName} 님의 데일리가 Discord 포럼에 게시되었습니다.`,
      fields: [
        { name: "작성자", value: displayName, inline: true },
        { name: "날짜", value: postDate, inline: true },
        { name: "스레드", value: threadName },
      ],
      color: 0x2ecc71,
    });
    res.json({ success: true, threadId: thread.id, threadName });
  } catch (err) {
    console.error("Post daily error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Visitor tracking API
app.post("/api/visit", async (req, res) => {
  try {
    const visitorId = req.body.visitorId || req.ip || 'anonymous';
    await pool.query(
      `INSERT INTO visits (visit_date, visitor_id) VALUES (CURRENT_DATE, $1) ON CONFLICT DO NOTHING`,
      [visitorId]
    );
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM visits WHERE visit_date = CURRENT_DATE`
    );
    res.json({ success: true, todayCount: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error("Visit tracking error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/visitors/today", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM visits WHERE visit_date = CURRENT_DATE`
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error("Visitor count error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Call member API (sends Discord DM)
app.post("/api/call-member/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!client.isReady()) {
      return res.status(503).json({ error: "Bot not connected" });
    }

    const user = await client.users.fetch(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const message = "🚨 긴급호출!! 🚨 누군가 당신을 찾고 있습니다!! 지금 당장 확인해주세요!! 빨리요!! 🏃💨";
    
    await user.send(message);
    emitActionAlert({
      title: "멤버 호출",
      description: `${user.tag || userId} 님에게 DM 호출을 보냈습니다.`,
      fields: [{ name: "User ID", value: userId, inline: true }],
      color: 0xe67e22,
    });
    res.json({ success: true, message: "DM sent" });
  } catch (err) {
    console.error("Call member error:", err.message);
    if (err.code === 50007) {
      res.status(400).json({ error: "Cannot send DM to this user (DMs disabled)" });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Poll APIs
app.get("/api/polls", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) as vote_count
      FROM polls p 
      ORDER BY p.is_active DESC, p.created_at DESC
    `);
    res.json({ success: true, polls: result.rows });
  } catch (err) {
    console.error("Get polls error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/polls/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pollResult = await pool.query(`SELECT * FROM polls WHERE id = $1`, [id]);
    if (pollResult.rows.length === 0) {
      return res.status(404).json({ error: "Poll not found" });
    }
    const votesResult = await pool.query(`
      SELECT voter_name, selected_option, comment, created_at 
      FROM votes WHERE poll_id = $1 ORDER BY created_at
    `, [id]);
    res.json({ 
      success: true, 
      poll: pollResult.rows[0], 
      votes: votesResult.rows 
    });
  } catch (err) {
    console.error("Get poll error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/polls", async (req, res) => {
  try {
    const { title, description, options, createdBy, deadline } = req.body;
    if (!title || !options || options.length < 2 || !createdBy) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await pool.query(`
      INSERT INTO polls (title, description, options, created_by, deadline)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [title, description || '', options, createdBy, deadline || null]);
    emitActionAlert({
      title: "투표 생성",
      description: title,
      fields: [
        { name: "작성자", value: createdBy, inline: true },
        { name: "마감", value: deadline || "-", inline: true },
        { name: "선택지", value: options.join("\n") },
      ],
    });
    res.json({ success: true, poll: result.rows[0] });
  } catch (err) {
    console.error("Create poll error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/polls/:id/vote", async (req, res) => {
  try {
    const { id } = req.params;
    const { voterName, selectedOption, comment } = req.body;
    if (!voterName || selectedOption === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const pollResult = await pool.query(`SELECT * FROM polls WHERE id = $1`, [id]);
    if (pollResult.rows.length === 0) {
      return res.status(404).json({ error: "Poll not found" });
    }
    const poll = pollResult.rows[0];
    if (!poll.is_active) {
      return res.status(400).json({ error: "Poll is closed" });
    }
    if (selectedOption < 0 || selectedOption >= poll.options.length) {
      return res.status(400).json({ error: "Invalid option selected" });
    }
    const result = await pool.query(`
      INSERT INTO votes (poll_id, voter_name, selected_option, comment)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (poll_id, voter_name) 
      DO UPDATE SET selected_option = $3, comment = $4, created_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [id, voterName, selectedOption, comment || '']);
    emitActionAlert({
      title: "투표 참여/수정",
      description: `${voterName} 님이 투표 #${id}에 참여했습니다.`,
      fields: [
        { name: "투표 ID", value: id, inline: true },
        { name: "이름", value: voterName, inline: true },
        { name: "선택", value: String(selectedOption), inline: true },
        { name: "코멘트", value: comment || "-" },
      ],
    });
    res.json({ success: true, vote: result.rows[0] });
  } catch (err) {
    console.error("Vote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/polls/:id/close", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE polls SET is_active = false WHERE id = $1 RETURNING *
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Poll not found" });
    }
    emitActionAlert({
      title: "투표 종료",
      description: `투표 #${id}가 종료되었습니다.`,
      fields: [{ name: "제목", value: result.rows[0].title || "-" }],
      color: 0xf1c40f,
    });
    res.json({ success: true, poll: result.rows[0] });
  } catch (err) {
    console.error("Close poll error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/polls/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM polls WHERE id = $1`, [id]);
    emitActionAlert({
      title: "투표 삭제",
      description: `투표 #${id}가 삭제되었습니다.`,
      fields: [{ name: "ID", value: id, inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete poll error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ideas API
app.get("/api/ideas", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.*, 
        (SELECT COUNT(*) FROM idea_likes WHERE idea_id = i.id) as like_count
      FROM ideas i 
      ORDER BY created_at DESC
    `);
    res.json({ success: true, ideas: result.rows });
  } catch (err) {
    console.error("Get ideas error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ideas", async (req, res) => {
  try {
    const { title, description, category, author } = req.body;
    if (!title || !author) {
      return res.status(400).json({ error: "title and author required" });
    }
    const result = await pool.query(`
      INSERT INTO ideas (title, description, category, author)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [title, description || '', category || 'general', author]);
    emitActionAlert({
      title: "아이디어 등록",
      description: title,
      fields: [
        { name: "작성자", value: author, inline: true },
        { name: "카테고리", value: category || "general", inline: true },
        { name: "설명", value: description || "-" },
      ],
    });
    res.json({ success: true, idea: result.rows[0] });
  } catch (err) {
    console.error("Create idea error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ideas/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    const { userName } = req.body;
    if (!userName) {
      return res.status(400).json({ error: "userName required" });
    }
    await pool.query(`
      INSERT INTO idea_likes (idea_id, user_name)
      VALUES ($1, $2)
      ON CONFLICT (idea_id, user_name) DO NOTHING
    `, [id, userName]);
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM idea_likes WHERE idea_id = $1`, [id]
    );
    emitActionAlert({
      title: "아이디어 좋아요",
      description: `${userName} 님이 아이디어 #${id}에 좋아요를 눌렀습니다.`,
      fields: [
        { name: "아이디어 ID", value: id, inline: true },
        { name: "이름", value: userName, inline: true },
      ],
    });
    res.json({ success: true, likeCount: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error("Like idea error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/ideas/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    const { userName } = req.body;
    if (!userName) {
      return res.status(400).json({ error: "userName required" });
    }
    await pool.query(`
      DELETE FROM idea_likes WHERE idea_id = $1 AND user_name = $2
    `, [id, userName]);
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM idea_likes WHERE idea_id = $1`, [id]
    );
    emitActionAlert({
      title: "아이디어 좋아요 취소",
      description: `${userName} 님이 아이디어 #${id} 좋아요를 취소했습니다.`,
      fields: [
        { name: "아이디어 ID", value: id, inline: true },
        { name: "이름", value: userName, inline: true },
      ],
      color: 0xf1c40f,
    });
    res.json({ success: true, likeCount: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error("Unlike idea error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ideas/:id/likes", async (req, res) => {
  try {
    const { id } = req.params;
    const { userName } = req.query;
    const likesResult = await pool.query(
      `SELECT user_name FROM idea_likes WHERE idea_id = $1`, [id]
    );
    const hasLiked = userName ? likesResult.rows.some(r => r.user_name === userName) : false;
    res.json({ 
      success: true, 
      likeCount: likesResult.rows.length,
      hasLiked,
      likers: likesResult.rows.map(r => r.user_name)
    });
  } catch (err) {
    console.error("Get idea likes error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/ideas/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['pending', 'reviewing', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const result = await pool.query(`
      UPDATE ideas SET status = $1 WHERE id = $2 RETURNING *
    `, [status, id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Idea not found" });
    }
    emitActionAlert({
      title: "아이디어 상태 변경",
      description: `아이디어 #${id} 상태가 ${status}(으)로 변경되었습니다.`,
      fields: [
        { name: "ID", value: id, inline: true },
        { name: "상태", value: status, inline: true },
        { name: "제목", value: result.rows[0].title || "-" },
      ],
      color: 0xf1c40f,
    });
    res.json({ success: true, idea: result.rows[0] });
  } catch (err) {
    console.error("Update idea status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/ideas/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM ideas WHERE id = $1`, [id]);
    emitActionAlert({
      title: "아이디어 삭제",
      description: `아이디어 #${id}가 삭제되었습니다.`,
      fields: [{ name: "ID", value: id, inline: true }],
      color: 0xe74c3c,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete idea error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

client.once("ready", () => {
  console.log(`Core Sync Bot online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "check-report") {
    const report = await generateReport();
    if (report) message.channel.send(report);
  }
});

cron.schedule(
  "0 11 * * 0",
  async () => {
    const report = await generateReport();
    if (!report) return;

    const channel = await client.channels.fetch(REPORT_CHANNEL_ID);
    if (channel?.isTextBased()) {
      channel.send(report);
    }
  },
  { timezone: "Asia/Seoul" }
);

cron.schedule(
  "0 20 * * 0",
  async () => {
    const webhookUrl = process.env.TEAM_WEEKLY_WEBHOOK_URL || "";
    if (!webhookUrl) {
      console.log("TEAM_WEEKLY_WEBHOOK_URL not set - skipping team weekly wrap-up");
      return;
    }
    try {
      const weekStart = currentWeekStartKST();
      const result = await generateSaveAndPostWeeklyReport(pool, weekStart, webhookUrl);
      console.log(`Team weekly wrap-up posted for ${result.weekStart}`);
    } catch (err) {
      console.error("Team weekly wrap-up error:", err.message);
    }
  },
  { timezone: "Asia/Seoul" }
);

function startDashboardServer(port) {
  return app.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard running at http://0.0.0.0:${port}`);
  });
}

startDashboardServer(PORT);
if (String(PORT) !== String(LEGACY_PORT)) {
  startDashboardServer(LEGACY_PORT);
}

if (BOT_TOKEN) {
  client.login(BOT_TOKEN).catch((err) => {
    console.error("Discord bot login failed:", err.message);
  });
} else {
  console.log("BOT_TOKEN not set - running in dashboard-only mode");
}
