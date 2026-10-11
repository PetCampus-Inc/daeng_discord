const allowedPaths = new Set(["/health", "/overview", "/members", "/schools", "/verifications"]);
const upstreamOrigin = new URL(process.env.SERVICE_ADMIN_API_ORIGIN || "https://api.knockdog.net");

async function proxyServiceAdmin(req, res) {
  if (req.method !== "GET" || !allowedPaths.has(req.path)) {
    return res.status(404).json({ error: "관리자 API 경로를 찾을 수 없습니다." });
  }

  const upstreamUrl = new URL(`/api/service-admin${req.url}`, upstreamOrigin);
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("json")) {
      console.error("Service admin upstream returned non-JSON response:", upstream.status);
      return res.status(502).json({
        error: "관리자 API 응답을 처리하지 못했습니다.",
        code: "SERVICE_ADMIN_UPSTREAM_INVALID_RESPONSE",
      });
    }

    const body = await upstream.text();
    return res.status(upstream.status).set("Cache-Control", "no-store").type("json").send(body);
  } catch (err) {
    console.error("Service admin upstream request failed:", err.code || err.message);
    return res.status(err.name === "TimeoutError" ? 504 : 502).json({
      error: "관리자 API에 연결하지 못했습니다.",
      code: "SERVICE_ADMIN_UPSTREAM_UNAVAILABLE",
    });
  }
}

module.exports = { proxyServiceAdmin };
