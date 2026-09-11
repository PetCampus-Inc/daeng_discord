const test = require("node:test");
const assert = require("node:assert/strict");

const { createCareersWebhookHandler } = require("./careers-webhook");

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("sends a careers application to Discord", async () => {
  let request;
  const handler = createCareersWebhookHandler({
    webhookUrl: "https://discord.example/webhook",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
  });
  const req = {
    body: JSON.stringify({
      name: "홍길동",
      phone: "010-1234-5678",
      email: "test@example.com",
      position: "Frontend 개발자",
      wantsJoinNotification: true,
    }),
    get: (name) => (name === "origin" ? "https://home.knockdog.net" : undefined),
  };
  const res = createResponse();

  await handler.post(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(request.url, "https://discord.example/webhook");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.embeds[0].fields[2].name, "합류 여부 안내");
  assert.equal(payload.embeds[0].fields[2].value, "희망");
});

test("supports the previous result-notification field name", async () => {
  let payload;
  const handler = createCareersWebhookHandler({
    webhookUrl: "https://discord.example/webhook",
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true };
    },
  });
  const req = {
    body: {
      name: "홍길동",
      phone: "010-1234-5678",
      email: "test@example.com",
      position: "Frontend 개발자",
      wantsResultNotification: true,
    },
    get: () => "https://home.knockdog.net",
  };

  await handler.post(req, createResponse());

  assert.equal(payload.embeds[0].fields[2].value, "희망");
});

test("rejects requests from another origin", async () => {
  let called = false;
  const handler = createCareersWebhookHandler({
    webhookUrl: "https://discord.example/webhook",
    fetchImpl: async () => {
      called = true;
      return { ok: true };
    },
  });
  const req = {
    body: "{}",
    get: () => "https://example.com",
  };
  const res = createResponse();

  await handler.post(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});
