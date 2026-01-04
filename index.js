const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fs = require("fs");
const cron = require("node-cron");

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CORE_ROLE_ID = process.env.CORE_ROLE_ID;

const DATA_FILE = "./sync-data.json";
const REQUIRED_COUNT = 5;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/* -------------------- 데이터 유틸 -------------------- */

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function resetData() {
  saveData({});
}

function getWeekLabel() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/* -------------------- 리포트 생성 -------------------- */

async function generateReport() {
  const data = loadData();
  const guild = client.guilds.cache.first();
  if (!guild) return null;

  await guild.members.fetch();

  const coreMembers = guild.members.cache.filter((m) =>
    m.roles.cache.has(CORE_ROLE_ID)
  );

  const lines = [];
  const underperformed = [];

  coreMembers.forEach((member) => {
    const count = data[member.id]?.count || 0;
    const line = `- ${member.displayName}: ${count} / ${REQUIRED_COUNT}`;
    lines.push(line);

    if (count < REQUIRED_COUNT) {
      underperformed.push(`<@${member.id}>`);
    }
  });

  const report =
`📊 Core Sync Report (${getWeekLabel()} 주차)

이번 주 Core Sync 기록을 공유합니다.
Core 기준은 주 ${REQUIRED_COUNT}회입니다.

${lines.join("\n")}

${
  underperformed.length
    ? `⚠️ 기준 미달: ${underperformed.join(" ")}`
    : "🎉 모든 Core 멤버가 기준을 충족했습니다!"
}

이번 주도 수고 많았습니다.
다음 주도 각자의 리듬에 맞게 참여해주세요 🙂`;

  return report;
}

/* -------------------- 이벤트 -------------------- */

client.once("ready", async () => {
  console.log(`🤖 Core Sync Bot online as ${client.user.tag}`);
});

/**
 * Forum(Thread) 글 카운트
 */
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  // Forum 채널의 Thread 글만 카운트
  if (
    message.channel.isThread() &&
    message.channel.parentId === FORUM_CHANNEL_ID
  ) {
    const data = loadData();
    const userId = message.author.id;

    if (!data[userId]) {
      data[userId] = { count: 0 };
    }
    data[userId].count += 1;
    saveData(data);
  }

  // 수동 리포트
  if (message.content === "check-report") {
    generateReport().then((report) => {
      if (report) message.channel.send(report);
    });
  }
});

/* -------------------- 스케줄 -------------------- */

// 매주 월요일 00:00 → 리셋
cron.schedule("0 0 * * 1", () => {
  console.log("🔄 Weekly reset");
  resetData();
});

// 매주 일요일 11:00 → 자동 리포트
cron.schedule("0 11 * * 0", async () => {
  const report = await g
