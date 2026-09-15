const SOURCE_URL = "https://smss.seoulmetro.co.kr/traininfo/traininfoUserMap.do";
const VIEW_URL = "https://smss.seoulmetro.co.kr/traininfo/traininfoUserView.do";
const STATIONS = [
  ["0410", "상계"],
  ["0411", "노원"],
  ["0412", "창동"],
  ["0413", "쌍문"],
  ["0414", "수유"],
  ["0415", "미아"],
  ["0416", "미아사거리"],
  ["0417", "길음"],
];
const STATION_INDEX = new Map(STATIONS.map(([code], index) => [code, index]));

function monitoringWindow(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minute < 7 * 60 + 30 || minute >= 9 * 60 + 10) return null;
  return {
    date: kst.toISOString().slice(0, 10),
    time: `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`,
    threshold: 3,
  };
}

function parseTrainPositions(html) {
  const trains = new Map();
  const tags = String(html).match(/<div\b[^>]*\bclass=["']T\d{4}_[YN]_2_v2\s+tip["'][^>]*>/g) || [];
  for (const tag of tags) {
    const classMatch = tag.match(/\bclass=["']T(\d{4})_[YN]_2_v2\s+tip["']/);
    const titleMatch = tag.match(/\btitle=["']([^"']+)["']/);
    const index = STATION_INDEX.get(classMatch?.[1]);
    const trainId = titleMatch?.[1].match(/^([A-Za-z]?\d+)열차\s/)?.[1];
    if (index === undefined || !trainId) continue;
    const station = STATIONS[index][1];
    const state = titleMatch[1].match(/(?:도착|접근|이동|출발)/)?.[0] || "위치 확인";
    // A train that has departed the last monitored station is outside the corridor.
    if (index === STATIONS.length - 1 && state === "출발") continue;
    trains.set(trainId, { id: trainId, index, station, state });
  }
  return [...trains.values()];
}

function findGaps(trains, threshold) {
  const ordered = [...trains].sort((a, b) => b.index - a.index || a.id.localeCompare(b.id));
  const gaps = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const ahead = ordered[i];
    const behind = ordered[i + 1];
    const distance = ahead.index - behind.index;
    if (distance >= threshold) gaps.push({ ahead, behind, distance });
  }
  return gaps;
}

function createSubwayGapAlert({ fetchImpl = fetch, env = process.env } = {}) {
  const webhookUrl = String(env.SUBWAY_GAP_DISCORD_WEBHOOK_URL || "").trim();
  let activeDate = "";
  let counts = new Map();
  let alerted = new Set();

  function reset() {
    activeDate = "";
    counts = new Map();
    alerted = new Set();
  }

  async function run({ now = new Date(), dryRun = false } = {}) {
    const window = monitoringWindow(now);
    if (!window) {
      reset();
      return { skipped: true, reason: "outside monitoring window" };
    }
    if (!webhookUrl && !dryRun) return { skipped: true, reason: "webhook not configured" };
    if (activeDate !== window.date) {
      reset();
      activeDate = window.date;
    }

    let html;
    try {
      const response = await fetchImpl(SOURCE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "line=4&isCb=N",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Subway source failed (${response.status})`);
      html = await response.text();
      if (!html.includes('class="4line"')) throw new Error("Subway source returned unexpected HTML");
    } catch (err) {
      counts = new Map();
      throw err;
    }

    const trains = parseTrainPositions(html);
    const gaps = findGaps(trains, window.threshold);
    const nextCounts = new Map();
    const nextAlerted = new Set();
    const sent = [];
    for (const gap of gaps) {
      const key = `${gap.ahead.id}:${gap.behind.id}`;
      const count = (counts.get(key) || 0) + 1;
      nextCounts.set(key, count);
      if (alerted.has(key)) {
        nextAlerted.add(key);
        continue;
      }
      if (count < 2) continue;
      if (!dryRun) {
        const content = [
          `🚇 **4호선 열차 간격 알림 · ${window.time} KST**`,
          `상계 → 길음 구간에서 연속 열차 간격이 **${gap.distance}정거장**입니다. (알림 기준: ${window.threshold}정거장)`,
          `앞 열차: ${gap.ahead.id} · ${gap.ahead.station} ${gap.ahead.state}`,
          `뒤 열차: ${gap.behind.id} · ${gap.behind.station} ${gap.behind.state}`,
          VIEW_URL,
        ].join("\n");
        const discordUrl = new URL(webhookUrl);
        discordUrl.searchParams.set("wait", "true");
        const discord = await fetchImpl(discordUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            thread_name: `4호선 간격 알림 ${window.date} ${window.time}`,
            allowed_mentions: { parse: [] },
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!discord.ok) throw new Error(`Subway Discord webhook failed (${discord.status})`);
        nextAlerted.add(key);
        alerted.add(key);
      }
      sent.push(gap);
    }
    counts = nextCounts;
    alerted = nextAlerted;
    return { skipped: false, threshold: window.threshold, trainCount: trains.length, gaps, sent };
  }

  return { run };
}

module.exports = { monitoringWindow, parseTrainPositions, findGaps, createSubwayGapAlert };
