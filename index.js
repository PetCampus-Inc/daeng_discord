const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");

const TOKEN = process.env.BOT_TOKEN;
const SYNC_CHANNEL_ID = process.env.SYNC_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID; // 운영자 채널 (선택)
const DATA_FILE = "./data.json";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function formatReport(data) {
  const rows = Object.values(data)
    .sort((a, b) => b.count - a.count)
    .map((u) => `- ${u.name}: ${u.count}`);
  return `**[Weekly Sync Count]**\n\n${rows.length ? rows.join("\n") : "- (no data)"}`;
}

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(process.env.SYNC_CHANNEL_ID);
    if (channel) {
      channel.send("🤖 Sync Bot is online. Test message.");
    }
  } catch (err) {
    console.error("Failed to send test message:", err);
  }
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  // 카운트: sync-up 채널만
  if (message.channel.id === SYNC_CHANNEL_ID) {
    const data = loadData();
    const userId = message.author.id;

    if (!data[userId]) {
      data[userId] = { name: message.author.username, count: 0 };
    }
    data[userId].name = message.author.username; // 닉 변경 반영
    data[userId].count += 1;
    saveData(data);
  }

  // 운영자 명령: !sync-report
  if (message.content === "!sync-report") {
    const data = loadData();
    message.channel.send(formatReport(data));
  }

  // 운영자 명령: !sync-reset (리셋)
  if (message.content === "!sync-reset") {
    saveData({});
    message.channel.send("✅ Sync count reset done.");
  }
});

client.login(TOKEN);
