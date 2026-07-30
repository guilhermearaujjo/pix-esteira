const crypto = require("node:crypto");
const {
  applyCors,
  parseJsonBody,
  requireHeaderToken
} = require("../../utils/http");
const { saveReceipt } = require("../../utils/pix-store");

module.exports = async (req, res) => {
  applyCors(req, res, ["POST", "OPTIONS"]);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  if (
    !requireHeaderToken(
      req,
      res,
      "x-ingest-token",
      process.env.AUTOMATE_INGEST_TOKEN,
      "AUTOMATE_INGEST_TOKEN"
    )
  ) {
    return;
  }

  try {
    const body = parseJsonBody(req);
    const amount = Number(body.amount ?? body.value ?? body.valor ?? 0);
    const payerName = String(
      body.payerName || body.nome || body.name || "Pagador não informado"
    ).trim();
    const approvedAt = new Date(
      body.occurredAt ||
        body.dataHora ||
        body.timestamp ||
        new Date().toISOString()
    );

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Number.isNaN(approvedAt.getTime())
    ) {
      return res.status(400).json({
        ok: false,
        error: "Valor ou data inválidos."
      });
    }

    const suppliedId = String(
      body.externalId || body.notificationId || body.id || ""
    ).trim();
    const externalId =
      suppliedId ||
      crypto
        .createHash("sha256")
        .update(`${payerName}|${amount}|${approvedAt.toISOString()}`)
        .digest("hex")
        .slice(0, 24);

    const created = await saveReceipt({
      id: `automate_${externalId.replace(/[/.]/g, "_")}`,
      provider: "AUTOMATE",
      providerPaymentId: externalId,
      payerName,
      amountCents: Math.round(amount * 100),
      approvedAt: approvedAt.toISOString(),
      approvedAtMs: approvedAt.getTime(),
      source: String(body.source || "Notificação do celular").slice(0, 80),
      paymentMethodId: "pix",
      paymentTypeId: "bank_transfer",
      providerStatus: "approved"
    });

    return res.status(200).json({
      ok: true,
      created,
      id: externalId
    });
  } catch (error) {
    console.error("[pix/ingest]", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao registrar o Pix recebido pelo Automate.",
      detail: error.message || String(error)
    });
  }
};
