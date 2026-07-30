const { applyCors, requireHeaderToken } = require("../../utils/http");
const { getLastSync, listReceipts } = require("../../utils/pix-store");

function parseDay(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return NaN;
  return new Date(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}-03:00`
  ).getTime();
}

module.exports = async (req, res) => {
  applyCors(req, res, ["GET", "OPTIONS"]);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Método não permitido." });
  }

  if (
    !requireHeaderToken(
      req,
      res,
      "x-panel-token",
      process.env.PANEL_API_TOKEN,
      "PANEL_API_TOKEN"
    )
  ) {
    return;
  }

  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    const from = String(req.query.from || today);
    const to = String(req.query.to || today);
    const fromMs = parseDay(from);
    const toMs = parseDay(to, true);

    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      return res.status(400).json({ ok: false, error: "Período inválido." });
    }

    const [{ receipts, summary }, lastSyncAt] = await Promise.all([
      listReceipts({ fromMs, toMs }),
      getLastSync()
    ]);

    return res.status(200).json({
      ok: true,
      receipts,
      summary: {
        ...summary,
        lastSyncAt
      },
      filter: { from, to }
    });
  } catch (error) {
    console.error("[pix/list]", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar os Pix.",
      detail: error.message || String(error)
    });
  }
};
