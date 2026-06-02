const express = require("express");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const cron = require("node-cron");
const { Pool, types: pgTypes } = require("pg");

// Keep DATE (OID 1082) as raw "YYYY-MM-DD" string to avoid TZ shifts
pgTypes.setTypeParser(1082, (val) => val);
const { getAssigneeStats, getProjects, getProjectStatuses, getMyIssues } = require("./src/jira-client");

const app = express();
const PORT = 5000;

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

const REQUIRED_COUNT = 3;
const THREAD_SCAN_LIMIT = 100;
const GUILD_ID = process.env.GUILD_ID;
const NOTION_LINK =
  "https://www.notion.so/2de6c15f67fb8039b0f7e6e9c7fe202f?v=2de6c15f67fb815e809d000ce19fbfe7";

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

app.get("/api/config", (req, res) => {
  res.json({
    checkinCutoffHour: parseInt(process.env.CHECKIN_CUTOFF_HOUR || "11", 10),
  });
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
    } = req.body || {};

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

    const fields = { start_time: startTime, end_time: endTime, done, tasks, blockers };
    const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (!provided.length) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const isCheckinWrite =
      done !== undefined || tasks !== undefined || blockers !== undefined;
    if (isCheckinWrite) {
      const today = todayKST();
      if (date !== today) {
        return res
          .status(400)
          .json({ error: "체크인은 오늘 날짜에만 가능합니다" });
      }
      const kstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
      const cutoff = parseInt(process.env.CHECKIN_CUTOFF_HOUR || "11", 10);
      if (kstHour >= cutoff) {
        return res
          .status(400)
          .json({ error: `체크인은 오전 ${cutoff}시 이전까지만 가능합니다` });
      }
    }

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

    const result = await pool.query(
      `SELECT start_time, end_time, done, tasks, blockers, updated_at
       FROM checkins WHERE check_date = $1 AND user_name = $2`,
      [date, userName]
    );
    const r = result.rows[0] || {};
    res.json({
      success: true,
      checkDate: date,
      checkin: {
        userName,
        startTime: r.start_time || "",
        endTime: r.end_time || "",
        done: r.done || "",
        tasks: r.tasks || "",
        blockers: r.blockers || "",
        updatedAt: r.updated_at,
      },
    });
  } catch (err) {
    console.error("Checkin error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/checkin/today", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_name, start_time, end_time, done, tasks, blockers, updated_at
       FROM checkins WHERE check_date = CURRENT_DATE ORDER BY updated_at DESC`
    );
    res.json({
      checkDate: todayKST(),
      checkins: result.rows.map((r) => ({
        userName: r.user_name,
        startTime: r.start_time,
        endTime: r.end_time,
        done: r.done,
        tasks: r.tasks,
        blockers: r.blockers,
        updatedAt: r.updated_at,
      })),
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
      `SELECT user_name, start_time, end_time, done, tasks, blockers, updated_at
       FROM checkins WHERE check_date = $1 AND user_name = $2`,
      [date, userName]
    );
    if (!result.rows.length) return res.json({ checkin: null, checkDate: date });
    const r = result.rows[0];
    res.json({
      checkDate: date,
      checkin: {
        userName: r.user_name,
        startTime: r.start_time,
        endTime: r.end_time,
        done: r.done,
        tasks: r.tasks,
        blockers: r.blockers,
        updatedAt: r.updated_at,
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
    for (const h of hours) {
      const text = (h.text || "").trim();
      const parsed = parseRangeFromText(text);
      await pool.query(
        `INSERT INTO checkins (check_date, user_name, hours_text, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (check_date, user_name) DO UPDATE SET
           hours_text = EXCLUDED.hours_text,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           updated_at = CURRENT_TIMESTAMP`,
        [h.date, userName, text, parsed.start, parsed.end]
      );
    }
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
      `SELECT user_name, check_date, start_time, end_time, hours_text
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
      byUser.get(row.user_name).push({
        date: dateStr,
        startTime: row.start_time,
        endTime: row.end_time,
        hoursText: row.hours_text,
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
    res.json({ success: true, memo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/memos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM memos WHERE id = $1", [id]);
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

    res.json({ success: true, announcement: result.rows[0], dmResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE announcements SET is_active = false WHERE id = $1", [id]);
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
    const reads = await pool.query(
      "SELECT user_name, created_at FROM announcement_reads WHERE announcement_id = $1 ORDER BY created_at",
      [id]
    );
    res.json({ success: true, readers: reads.rows });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
});

if (BOT_TOKEN) {
  client.login(BOT_TOKEN);
} else {
  console.log("BOT_TOKEN not set - running in dashboard-only mode");
}
