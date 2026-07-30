const { applyCors, safeEqual } = require("../../utils/http");
const { searchPayments } = require("../../utils/mercado-pago");
const { normalizePayment } = require("../../utils/normalize");
const { markSync, saveReceipt } = require("../../utils/pix-store");

function authorized(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const headerToken = String(req.headers["x-sync-token"] || "");
  const expected = String(process.env.CRON_SECRET || "");
  return (
    Boolean(expected) &&
    (safeEqual(bearer, expected) || safeEqual(headerToken, expected))
  );
}

module.exports = async (req, res) => {
  applyCors(req, res, ["GET", "POST", "OPTIONS"]);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "CRON_SECRET ainda não foi configurado no Vercel."
    });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Não autorizado." });
  }

  try {
    const minutes = Math.min(
      Math.max(Number(req.query.minutes || 120), 5),
      10080
    );
    const payments = await searchPayments({ minutes });
    let pixApproved = 0;
    let imported = 0;

    for (const payment of payments) {
      const receipt = normalizePayment(payment);
      if (!receipt) continue;
      pixApproved += 1;
      if (await saveReceipt(receipt)) imported += 1;
    }

    await markSync({
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes
    });

    return res.status(200).json({
      ok: true,
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes
    });
  } catch (error) {
    console.error("[pix/sync]", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao conferir pagamentos no Mercado Pago.",
      detail: error.message || String(error)
    });
  }
};
