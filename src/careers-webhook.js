const ALLOWED_ORIGINS = new Set([
  "https://home.knockdog.net",
  "http://localhost:3000",
]);

function text(value, max = 900) {
  return String(value || "").trim().slice(0, max) || "-";
}

function setCorsHeaders(req, res) {
  const origin = req.get("origin");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function createCareersWebhookHandler({
  webhookUrl = process.env.CAREERS_DISCORD_WEBHOOK_URL || "",
  fetchImpl = fetch,
} = {}) {
  return {
    options(req, res) {
      setCorsHeaders(req, res);
      res.sendStatus(204);
    },

    async post(req, res) {
      setCorsHeaders(req, res);

      if (!ALLOWED_ORIGINS.has(req.get("origin"))) {
        return res.status(403).json({ error: "origin not allowed" });
      }
      if (!webhookUrl) {
        return res.status(503).json({ error: "careers webhook not configured" });
      }

      try {
        const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
        if (!data.name || !data.phone || !data.email || !data.position) {
          return res.status(400).json({ error: "required application fields missing" });
        }

        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "Knockdog Careers",
            allowed_mentions: { parse: [] },
            embeds: [
              {
                title: "새 지원자가 접수되었습니다",
                color: 0x57f287,
                fields: [
                  { name: "지원 포지션", value: text(data.position), inline: true },
                  { name: "이름", value: text(data.name), inline: true },
                  { name: "결과 안내", value: data.wantsResultNotification ? "희망" : "희망하지 않음", inline: true },
                  { name: "연락처", value: text(data.phone), inline: true },
                  { name: "이메일", value: text(data.email), inline: false },
                  { name: "성별", value: text(data.gender), inline: true },
                  { name: "재직여부", value: text(data.employment), inline: true },
                  { name: "거주지역", value: text(data.residence), inline: true },
                  { name: "포트폴리오", value: text(data.portfolio), inline: false },
                  { name: "자기소개", value: text(data.introduction), inline: false },
                ],
                timestamp: new Date().toISOString(),
              },
            ],
          }),
        });

        if (!response.ok) {
          const responseText = await response.text().catch(() => "");
          throw new Error(`Discord webhook failed (${response.status}) ${responseText.slice(0, 200)}`);
        }

        return res.json({ success: true });
      } catch (error) {
        console.error("Careers webhook error:", error.message);
        return res.status(500).json({ error: "failed to send careers webhook" });
      }
    },
  };
}

module.exports = { createCareersWebhookHandler };
