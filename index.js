require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fs = require("fs");
const cron = require("node-cron");

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CORE_ROLE_ID = process.env.CORE_ROLE_ID;

const DATA_FILE = "./sync-data.json";
const REQUIRED_COUNT = 5;

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

/* -------------------- Utils -------------------- */

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * KST 기준 주차 (월요일 기준)
 */
function getWeekKey() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const monday = new Date(kst);
  monday.setDate(kst.getDate() - ((kst.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

/* -------------------- Report -------------------- */

async function generateReport() {
  const data = loadData();
  const weekKey = getWeekKey();
  const weekData = data[weekKey] || {};

  const guild = client.guilds.cache.first();
  if (!guild) return null;

  await guild.members.fetch();

  const coreMembers = guild.members.cache.filter(
    (m) => !m.user.bot && m.roles.cache.has(CORE_ROLE_ID)
  );

  const lines = [];
  const underperformed = [];

  coreMembers.forEach((member) => {
    const count = weekData[member.id] || 0;
    lines.push(`- ${member.displayName}: ${count} / ${REQUIRED_COUNT}`);

    if (count < REQUIRED_COUNT) {
      underperformed.push(`<@${member.id}>`);
    }
  });

  return [
    `📊 Core Sync Report (${weekKey} 주차)`,
    ``,
    `이번 주 Core Sync 기록을 공유합니다.`,
    `Core 기준은 주 ${REQUIRED_COUNT}회입니다.`,
    ``,
    ...lines,
    ``,
    underperformed.length
      ? `⚠️ 기준 미달: ${underperformed.join(" ")}`
      : `🎉 모든 Core 멤버가 기준을 충족했습니다!`,
    ``,
    `이번 주도 수고 많았습니다.`,
    `다음 주도 각자의 리듬에 맞게 참여해주세요 🙂`,
  ].join("\n");
}

/* -------------------- Events -------------------- */

client.once("ready", () => {
  console.log(`🤖 Core Sync Bot online as ${client.user.tag}`);
});

/**
 * Forum(Thread) 글 카운트
 */
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  if (
    message.channel.isThread() &&
    message.channel.parentId === FORUM_CHANNEL_ID
  ) {
    const data = loadData();
    const weekKey = getWeekKey();

    if (!data[weekKey]) data[weekKey] = {};
    if (!data[weekKey][message.author.id]) {
      data[weekKey][message.author.id] = 0;
    }

    data[weekKey][message.author.id] += 1;
    saveData(data);
  }

  // 수동 리포트
  if (message.content === "check-report") {
    generateReport().then((report) => {
      if (report) message.channel.send(report);
    });
  }
});

/* -------------------- Schedule -------------------- */

// 매주 일요일 11:00 KST 자동 리포트
cron.schedule(
  "0 11 * * 0",
  async () => {
    const report = await generateReport();
    if (!report) return;

    const channel = await client.channels.fetch(REPORT_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      channel.send(report);
    }
  },
  { timezone: "Asia/Seoul" }
);

/* -------------------- Start -------------------- */

client.login(BOT_TOKEN);
