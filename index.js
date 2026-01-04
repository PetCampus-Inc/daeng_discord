const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const fs = require("fs");
const cron = require("node-cron");

const TOKEN = process.env.BOT_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;

const DATA_FILE = "./data.json";
const WEEKLY_TARGET = 5;

/* ------------------ 기본 유틸 ------------------ */

function getWeekKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 월요일
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { weekKey: getWeekKey(), users: {} };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function ensureWeek(data) {
  const currentWeek = getWeekKey();
  if (data.weekKey !== currentWeek) {
    return { weekKey: currentWeek, users: {} };
  }
  return data;
}

/* ------------------ 리포트 포맷 ------------------ */

function formatWeeklyReport(data, tagUnderperformed = false) {
  const lines = [];
  const mentions = [];

  Object.entries(data.users).forEach(([userId, u]) => {
    const success = u.count >= WEEKLY_TARGET;
    const emoji = success ? " 🎉" : "";
    lines.push(`- ${u.name}: ${u.count} / ${WEEKLY_TARGET}${emoji}`);

    if (!success && tagUnderperformed) {
      mentions.push(`<@${userId}>`);
    }
  });

  return `📊 **Core Sync Report (${data.weekKey} 주차)**

이번 주 Core Sync 기록을 공유합니다.
Core 기준은 주 ${WEEKLY_TARGET}회입니다.

${lines.length ? lines.join("\n") : "- 기록 없음"}

이번 주도 수고 많았습니다.
다음 주도 각자의 리듬에 맞게 참여해주세요 🙂

${mentions.length ? `\n⚠️ 기준 미달: ${mentions.join(" ")}` : ""}`;
}

/* ------------------ Discord Client ------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ------------------ Forum 글 작성 카운트 ------------------ */

client.on("threadCreate", async (thread) => {
  if (thread.parentId !== FORUM_CHANNEL_ID) return;

  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter || starter.author.bot) return;

    let data = ensureWeek(loadData());

    const userId = starter.author.id;
    if (!data.users[userId]) {
      data.users[userId] = {
        name: starter.author.username,
        count: 0,
      };
    }

    data.users[userId].name = starter.author.username;
    data.users[userId].count += 1;

    saveData(data);
  } catch (e) {
    console.error("threadCreate error:", e);
  }
});

/* ------------------ 수동 리포트 ------------------ */

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content !== "check-report") return;

  let data = ensureWeek(loadData());
  saveData(data);

  const channel = await client.channels.fetch(REPORT_CHANNEL_ID);
  channel.send(formatWeeklyReport(data, false));
});

/* ------------------ 자동 리포트 (일요일 11시) ------------------ */

cron.schedule("0 11 * * 0", async () => {
  let data = ensureWeek(loadData());

  const channel = await client.channels.fetch(REPORT_CHANNEL_ID);
  await channel.send(formatWeeklyReport(data, true));

  saveData(data);
});

/* ------------------ 주간 리셋 (월요일 00시) ------------------ */

cron.schedule("0 0 * * 1", () => {
  saveData({
    weekKey: getWeekKey(),
    users: {},
  });
});

/* ------------------ Ready ------------------ */

client.once("ready", () => {
  console.log(`🤖 Core Sync Bot online as ${client.user.tag}`);
});

client.login(TOKEN);
