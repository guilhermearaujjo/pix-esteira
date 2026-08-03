const { applyCors, safeEqual } = require("../../utils/http");
const {
  createAccountReportConfig,
  downloadAccountReport,
  getAccountReportConfig,
  listAccountReports,
  requestAccountReport,
  searchPayments,
  updateAccountReportConfig
} = require("../../utils/mercado-pago");
const { normalizePayment } = require("../../utils/normalize");
const {
  configNeedsUpdate,
  parseAccountReport,
  reportConfig
} = require("../../utils/account-report");
const {
  finishReportJob,
  getReportState,
  listPendingReportJobs,
  markReportConfigured,
  markSync,
  reopenReportJob,
  saveReceipt,
  saveReportJob
} = require("../../utils/pix-store");

const REPORT_RETRY_AFTER_MS = 60_000;

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

async function ensureReportConfiguration() {
  const existing = await getAccountReportConfig();

  if (!existing) {
    const created = await createAccountReportConfig(reportConfig());
    await markReportConfigured({ action: "created" });
    return { action: "created", config: created };
  }

  if (configNeedsUpdate(existing)) {
    const updated = await updateAccountReportConfig(reportConfig(existing));
    await markReportConfigured({ action: "updated" });
    return { action: "updated", config: updated };
  }

  return { action: "unchanged", config: existing };
}

function reportPeriod() {
  const end = new Date();
  const begin = new Date(end.getTime() - 72 * 60 * 60_000);

  return {
    beginDate: begin.toISOString(),
    endDate: end.toISOString()
  };
}

async function importReceipts(receipts) {
  let imported = 0;

  for (const receipt of receipts) {
    if (await saveReceipt(receipt)) imported += 1;
  }

  return imported;
}

async function processReadyReports(pendingJobs) {
  if (!pendingJobs.length) {
    return {
      imported: 0,
      pixFound: 0,
      processed: 0,
      stillPending: 0
    };
  }

  const availableReports = await listAccountReports();
  const reportsById = new Map(
    availableReports.map((report) => [
      String(report.id || ""),
      report
    ])
  );

  let imported = 0;
  let pixFound = 0;
  let processed = 0;
  let stillPending = 0;

  for (const job of pendingJobs) {
    const report = reportsById.get(String(job.id));

    const fileName =
      (report && report.file_name) ||
      job.fileName ||
      job.file_name ||
      "";

    if (fileName) {
      const csv = await downloadAccountReport(fileName);
      const receipts = parseAccountReport(csv);
      const created = await importReceipts(receipts);

      imported += created;
      pixFound += receipts.length;
      processed += 1;

      await finishReportJob(job.id, {
        status: "processed",
        fileName,
        rowsAccepted: receipts.length,
        imported: created
      });

      continue;
    }

    /*
     * Versões anteriores marcavam o relatório como expirado
     * depois de 30 minutos.
     *
     * Como o Mercado Pago pode levar mais tempo para gerar
     * o arquivo, recuperamos esses relatórios e continuamos
     * consultando até o arquivo ficar disponível.
     */
    if (job.status === "expired") {
      await reopenReportJob(job.id, {
        providerStatus:
          (report && report.status) ||
          job.providerStatus ||
          "not_ready",
        recoveredFromExpiredAt: job.finishedAt || null
      });
    }

    stillPending += 1;
  }

  return {
    imported,
    pixFound,
    processed,
    stillPending
  };
}

async function requestReportIfNeeded(
  stillPending,
  reportsProcessed
) {
  if (stillPending > 0) {
    return {
      requested: false,
      pending: stillPending
    };
  }

  if (reportsProcessed > 0) {
    return {
      requested: false,
      pending: 0
    };
  }

  const state = await getReportState();
  const lastRequestedAtMs = Number(
    state.lastRequestedAtMs || 0
  );

  if (
    lastRequestedAtMs > 0 &&
    Date.now() - lastRequestedAtMs < REPORT_RETRY_AFTER_MS
  ) {
    return {
      requested: false,
      pending: 0
    };
  }

  const period = reportPeriod();
  const report = await requestAccountReport(period);

  await saveReportJob(report, period);

  return {
    requested: true,
    pending: 1,
    reportId: String(report.id)
  };
}

module.exports = async (req, res) => {
  applyCors(req, res, ["GET", "POST", "OPTIONS"]);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      ok: false,
      error: "Método não permitido."
    });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "CRON_SECRET ainda não foi configurado no Vercel."
    });
  }

  if (!authorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Não autorizado."
    });
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

      if (await saveReceipt(receipt)) {
        imported += 1;
      }
    }

    const reportConfiguration =
      await ensureReportConfiguration();

    const pendingJobs =
      await listPendingReportJobs();

    const reportImport =
      await processReadyReports(pendingJobs);

    imported += reportImport.imported;

    const reportRequest =
      await requestReportIfNeeded(
        reportImport.stillPending,
        reportImport.processed
      );

    const reportPending =
      reportRequest.pending > 0 ||
      reportImport.stillPending > 0;

    await markSync({
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig: reportConfiguration.action,
      reportPixFound: reportImport.pixFound,
      reportsProcessed: reportImport.processed,
      reportPending
    });

    return res.status(200).json({
      ok: true,
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig: reportConfiguration.action,
      reportPixFound: reportImport.pixFound,
      reportsProcessed: reportImport.processed,
      reportRequested: reportRequest.requested,
      reportPending
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
