const { Client, GatewayIntentBits, Partials } = require("discord.js");
const cron = require("node-cron");

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CORE_ROLE_ID = process.env.CORE_ROLE_ID;

const REQUIRED_COUNT = 5;
const THREAD_SCAN_LIMIT = 30;
const NOTION_LINK =
  "https://www.notion.so/2de6c15f67fb8039b0f7e6e9c7fe202f?v=2de6c15f67fb815e809d000ce19fbfe7";

/* -------------------- Client -------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/* -------------------- Date Utils -------------------- */

function getWeekKey() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
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

/* -------------------- Parsing -------------------- */

/**
 * 제목 형식: [YYYY-MM-DD / 이름]
 * 아니면 null
 */
function parseThreadTitle(title) {
  const match = title.match(/^\[(\d{4}-\d{2}-\d{2}) \/ .+\]$/);
  if (!match) return null;

  return { dayKey: match[1] };
}

/* -------------------- Core Logic -------------------- */

async function countCoreSyncForWeek(weekKey) {
  const forum = await client.channels.fetch(FORUM_CHANNEL_ID);

  // 최근 스레드만
  const active = await forum.threads.fetchActive({
    limit: THREAD_SCAN_LIMIT,
  });

  const archived = await forum.threads.fetchArchived({
    limit: THREAD_SCAN_LIMIT,
  });

  const threads = [
    ...active.threads.values(),
    ...archived.threads.values(),
  ];

  // userId -> Set<dayKey>
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

/* -------------------- Report -------------------- */

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

/* -------------------- Events -------------------- */

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

/* -------------------- Schedule -------------------- */

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

/* -------------------- Start -------------------- */

client.login(BOT_TOKEN);
