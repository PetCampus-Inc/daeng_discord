const express = require("express");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const cron = require("node-cron");

const app = express();
const PORT = 5000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CORE_ROLE_ID = process.env.CORE_ROLE_ID;

const REQUIRED_COUNT = 5;
const THREAD_SCAN_LIMIT = 100;
const NOTION_LINK =
  "https://www.notion.so/2de6c15f67fb8039b0f7e6e9c7fe202f?v=2de6c15f67fb815e809d000ce19fbfe7";

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
  const match = title.match(/^\[(\d{4}-\d{2}-\d{2}) \/ .+\]$/);
  if (!match) return null;
  return { dayKey: match[1] };
}

async function countCoreSyncForWeek(weekKey) {
  const forum = await client.channels.fetch(FORUM_CHANNEL_ID);

  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: THREAD_SCAN_LIMIT });

  const threads = [
    ...active.threads.values(),
    ...archived.threads.values(),
  ];

  const userDays = new Map();

  for (const thread of threads) {
    const parsed = parseThreadTitle(thread.name);
    if (!parsed) continue;

    const date = new Date(parsed.dayKey);
    if (getWeekKeyFromDate(date) !== weekKey) continue;

    const userId = thread.ownerId;
    if (!userId) continue;

    if (!userDays.has(userId)) {
      userDays.set(userId, new Set());
    }

    userDays.get(userId).add(parsed.dayKey);
  }

  return userDays;
}

async function getCoreMembersData(weekKey) {
  const userDays = await countCoreSyncForWeek(weekKey);

  const guild = client.guilds.cache.first();
  if (!guild) return [];

  await guild.members.fetch();

  const coreMembers = guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CORE_ROLE_ID)
  );

  const membersData = [];

  for (const member of coreMembers.values()) {
    const count = userDays.get(member.id)?.size ?? 0;
    const days = userDays.get(member.id) ? Array.from(userDays.get(member.id)) : [];

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
    });
  }

  membersData.sort((a, b) => b.syncCount - a.syncCount);

  return membersData;
}

async function generateReport() {
  const weekKey = getWeekKey();
  const userDays = await countCoreSyncForWeek(weekKey);

  const guild = client.guilds.cache.first();
  if (!guild) return null;

  await guild.members.fetch();

  const coreMembers = guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CORE_ROLE_ID)
  );

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

app.get("/api/sync-data", async (req, res) => {
  try {
    const weekOffset = parseInt(req.query.weekOffset) || 0;
    const weekKey = getWeekKey(weekOffset);
    const membersData = await getCoreMembersData(weekKey);

    res.json({
      success: true,
      weekKey,
      requiredCount: REQUIRED_COUNT,
      members: membersData,
      botConnected: client.isReady(),
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      botConnected: client.isReady(),
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
