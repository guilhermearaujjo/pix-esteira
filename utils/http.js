const crypto = require("node:crypto");

function applyCors(req, res, methods = ["GET", "OPTIONS"]) {
  const configuredOrigin = String(process.env.PANEL_ORIGIN || "").trim();
  const requestOrigin = String(req.headers.origin || "").trim();

  if (configuredOrigin && requestOrigin === configuredOrigin) {
    res.setHeader("Access-Control-Allow-Origin", configuredOrigin);
    res.setHeader("Vary", "Origin");
  } else if (!configuredOrigin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Panel-Token, X-Sync-Token, X-Ingest-Token"
  );
  res.setHeader("Cache-Control", "no-store");
}

function safeEqual(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireHeaderToken(req, res, headerName, expected, label) {
  const received = req.headers[String(headerName).toLowerCase()] || "";
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: `${label} ainda não foi configurado no Vercel.`
    });
    return false;
  }
  if (!safeEqual(received, expected)) {
    res.status(401).json({ ok: false, error: "Não autorizado." });
    return false;
  }
  return true;
}

function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body;
}

module.exports = {
  applyCors,
  parseJsonBody,
  requireHeaderToken,
  safeEqual
};
