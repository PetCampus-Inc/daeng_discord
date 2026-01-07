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
 * KST 기준 날짜 키 (YYYY-MM-DD)
 */
function getDayKey() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * KST 기준 주차 (월요일 기준) 키 (YYYY-MM-DD)
 */
function getWeekKey() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const monday = new Date(kst);
  monday.setDate(kst.getDate() - ((kst.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * weekData[userId]가 예전(number) 포맷일 수도 있으니,
 * 항상 { count, days } 형태로 보정해서 반환
 */
function ensureUserEntry(weekData, userId) {
  if (!weekData[userId]) {
    weekData[userId] = { count: 0, days: {} };
    return weekData[userId];
  }

  // 기존 포맷(숫자) 마이그레이션
  if (typeof weekData[userId] === "number") {
    weekData[userId] = { count: weekData[userId], days: {} };
    return weekData[userId];
  }

  // 누락 필드 보정
  if (typeof weekData[userId].count !== "number") weekData[userId].count = 0;
  if (!weekData[userId].days || typeof weekData[userId].days !== "object") {
    weekData[userId].days = {};
  }

  return weekData[userId];
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
    const entry = ensureUserEntry(weekData, member.id);
    const count = entry.count || 0;

    lines.push(`- ${member.displayName}: ${count} / ${REQUIRED_COUNT}`);

    if (count < REQUIRED_COUNT) {
      underperformed.push(`<@${member.id}>`);
    }
  });

  return [
    `Core Sync Report (${weekKey} 주차)`,
    ``,
    `이번 주 Core Sync 기록을 공유합니다.`,
    `Core 기준은 주 ${REQUIRED_COUNT}회입니다.`,
    ``,
    ...lines,
    ``,
    underperformed.length
      ? `기준 미달: ${underperformed.join(" ")}`
      : `모든 Core 멤버가 기준을 충족했습니다.`,
    ``,
    `이번 주도 수고 많았습니다.`,
  ].join("\n");
}

/* -------------------- Events -------------------- */

client.once("ready", () => {
  console.log(`Core Sync Bot online as ${client.user.tag}`);
});

/**
 * Forum(Thread) 글 카운트
 * - "하루에 유저당 1회만 +1" 보장
 */
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  if (
    message.channel.isThread() &&
    message.channel.parentId === FORUM_CHANNEL_ID
  ) {
    const data = loadData();
    const weekKey = getWeekKey();
    const dayKey = getDayKey();

    if (!data[weekKey]) data[weekKey] = {};
    const weekData = data[weekKey];

    const entry = ensureUserEntry(weekData, message.author.id);

    // 이미 오늘 카운트했다면 무시
    if (entry.days[dayKey]) return;

    // 오늘 첫 참여면 +1 하고 날짜 기록
    entry.count += 1;
    entry.days[dayKey] = true;

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
