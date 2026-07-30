const { applyCors } = require("../utils/http");
const { getDb } = require("../utils/firebase");

module.exports = async (req, res) => {
  applyCors(req, res, ["GET", "OPTIONS"]);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  try {
    getDb();
    return res.status(200).json({
      ok: true,
      service: "pix-esteira",
      firebase: true,
      mercadoPago: Boolean(process.env.MP_ACCESS_TOKEN),
      webhookSecret: Boolean(process.env.MP_WEBHOOK_SECRET)
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: error.message || String(error)
    });
  }
};
