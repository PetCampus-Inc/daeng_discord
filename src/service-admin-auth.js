const crypto = require("crypto");

function safeCredentialEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requireServiceAdmin(req, res, next) {
  const allowPublicNoAuth = process.env.SERVICE_ADMIN_ALLOW_PUBLIC_NO_AUTH === "true";
  const allowLocalNoAuth =
    process.env.NODE_ENV !== "production" &&
    process.env.SERVICE_ADMIN_ALLOW_LOCAL_NO_AUTH === "true" &&
    isLoopbackRequest(req);
  if (allowPublicNoAuth || allowLocalNoAuth) return next();

  const expectedUser = process.env.SERVICE_ADMIN_USER || "";
  const expectedPassword = process.env.SERVICE_ADMIN_PASSWORD || "";
  if (!expectedUser || !expectedPassword) {
    if (process.env.NODE_ENV !== "production") return next();
    return res.status(503).json({
      error: "SERVICE_ADMIN_USER와 SERVICE_ADMIN_PASSWORD 설정이 필요합니다.",
    });
  }

  const header = req.get("authorization") || "";
  let suppliedUser = "";
  let suppliedPassword = "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        suppliedUser = decoded.slice(0, separator);
        suppliedPassword = decoded.slice(separator + 1);
      }
    } catch (_) {
      // Handled as an invalid credential below.
    }
  }

  if (
    safeCredentialEqual(suppliedUser, expectedUser) &&
    safeCredentialEqual(suppliedPassword, expectedPassword)
  ) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Knockdog Service Admin", charset="UTF-8"');
  return res.status(401).send("관리자 인증이 필요합니다.");
}

module.exports = { requireServiceAdmin };
