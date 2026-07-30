const { applyCors, parseJsonBody } = require("../../utils/http");
const {
  getPayment,
  getPaymentsFromOrder
} = require("../../utils/mercado-pago");
const { normalizePayment } = require("../../utils/normalize");
const { saveReceipt } = require("../../utils/pix-store");
const { verifyWebhookSignature } = require("../../utils/signature");

function notificationData(req, body) {
  return {
    dataId: String(
      (body.data && body.data.id) ||
        req.query["data.id"] ||
        req.query.data_id ||
        req.query.id ||
        ""
    ),
    type: String(
      body.type || body.topic || req.query.type || req.query.topic || "payment"
    ).toLowerCase()
  };
}

module.exports = async (req, res) => {
  applyCors(req, res, ["POST", "GET", "OPTIONS"]);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["POST", "GET"].includes(req.method)) {
    res.setHeader("Allow", "POST, GET");
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  try {
    const body = parseJsonBody(req);
    const { dataId, type } = notificationData(req, body);

    if (!dataId) {
      return res.status(200).json({ ok: true, ignored: "sem data.id" });
    }

    const secret = String(process.env.MP_WEBHOOK_SECRET || "");
    if (!secret) {
      console.error("[pix/webhook] MP_WEBHOOK_SECRET não configurado.");
      return res.status(503).json({
        ok: false,
        error: "Assinatura secreta do Webhook não configurada."
      });
    }

    const validSignature = verifyWebhookSignature({
      signature: req.headers["x-signature"],
      dataId,
      requestId: req.headers["x-request-id"],
      secret
    });

    if (!validSignature) {
      return res.status(401).json({
        ok: false,
        error: "Assinatura do Webhook inválida."
      });
    }

    const payments =
      type === "order" || type === "orders"
        ? await getPaymentsFromOrder(dataId)
        : [await getPayment(dataId)];

    let imported = 0;
    for (const payment of payments) {
      const receipt = normalizePayment(payment);
      if (!receipt) continue;
      if (await saveReceipt(receipt)) imported += 1;
    }

    return res.status(200).json({ ok: true, imported });
  } catch (error) {
    console.error("[pix/webhook]", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao processar o Webhook.",
      detail: error.message || String(error)
    });
  }
};
