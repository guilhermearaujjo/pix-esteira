const {
  applyCors,
  safeEqual
} = require("../../utils/http");

const {
  createAccountReportConfig,
  downloadAccountReport,
  getAccountReportConfig,
  getAccountReportTask,
  requestAccountReport,
  searchAccountReports,
  searchPayments,
  updateAccountReportConfig
} = require("../../utils/mercado-pago");

const {
  normalizePayment
} = require("../../utils/normalize");

const {
  configNeedsUpdate,
  parseAccountReport,
  reportConfig
} = require("../../utils/account-report");

const {
  finishReportJob,
  getReportState,
  listPendingReportJobs,
  markReportChecked,
  markReportConfigured,
  markReportFileImported,
  markReportRequestBlocked,
  markSync,
  reopenReportJob,
  reportFileAlreadyImported,
  saveReceipt,
  saveReportJob
} = require("../../utils/pix-store");

const REPORT_RETRY_AFTER_MS =
  65 * 60_000;

const REPORT_QUOTA_COOLDOWN_MS =
  12 * 60 * 60_000;

function authorized(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  const bearer =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  const headerToken = String(
    req.headers["x-sync-token"] || ""
  );

  const expected = String(
    process.env.CRON_SECRET || ""
  );

  return (
    Boolean(expected) &&
    (
      safeEqual(bearer, expected) ||
      safeEqual(headerToken, expected)
    )
  );
}

async function ensureReportConfiguration() {
  const existing =
    await getAccountReportConfig();

  if (!existing) {
    const created =
      await createAccountReportConfig(
        reportConfig()
      );

    await markReportConfigured({
      action: "created"
    });

    return {
      action: "created",
      config: created
    };
  }

  if (configNeedsUpdate(existing)) {
    const updated =
      await updateAccountReportConfig(
        reportConfig(existing)
      );

    await markReportConfigured({
      action: "updated"
    });

    return {
      action: "updated",
      config: updated
    };
  }

  return {
    action: "unchanged",
    config: existing
  };
}

function reportPeriod() {
  const end = new Date();

  const begin = new Date(
    end.getTime() - 72 * 60 * 60_000
  );

  return {
    beginDate: begin.toISOString(),
    endDate: end.toISOString()
  };
}

async function importReceipts(receipts) {
  let imported = 0;

  for (const receipt of receipts) {
    if (await saveReceipt(receipt)) {
      imported += 1;
    }
  }

  return imported;
}

async function processReadyReports(pendingJobs) {
  if (!pendingJobs.length) {
    return {
      imported: 0,
      pixFound: 0,
      processed: 0,
      failed: 0,
      stillPending: 0
    };
  }

  let imported = 0;
  let pixFound = 0;
  let processed = 0;
  let failed = 0;
  let stillPending = 0;

  // Limite de jobs verificados por execução: evita estourar o
  // maxDuration (30s) do Vercel quando a fila de jobs acumula.
  // Os jobs não vistos nesta rodada continuam pendentes e serão
  // conferidos na próxima sincronização.
  const REPORT_JOBS_PER_RUN = 6;
  const jobsToCheck = pendingJobs.slice(
    0,
    REPORT_JOBS_PER_RUN
  );
  const skippedJobs =
    pendingJobs.length - jobsToCheck.length;

  for (const job of jobsToCheck) {
    // Cada job agora tem seu próprio try/catch "à prova de tudo":
    // um erro (de rede, do Mercado Pago, de parsing do CSV etc.)
    // em UM job nunca mais derruba a sincronização inteira. Antes,
    // apenas erro 404 era tolerado — qualquer outro erro (400 de
    // tarefa expirada, 429, timeout...) fazia o /api/pix/sync
    // inteiro falhar com 500, mesmo que os outros jobs estivessem
    // OK. Isso explica o botão "Sincronizar" falhando sempre que
    // havia um job problemático na fila.
    try {
      const report = await getAccountReportTask(
        job.id
      );

      const providerStatus = String(
        (report && report.status) || "pending"
      );

      const reportId =
        report && report.report_id
          ? String(report.report_id)
          : null;

      const fileName =
        (report && report.file_name) ||
        job.fileName ||
        job.file_name ||
        "";

      if (fileName) {
        const reportFile = {
          id: reportId || job.id,
          file_name: fileName,
          status: providerStatus,
          begin_date:
            (report && report.begin_date) ||
            job.beginDate ||
            null,
          end_date:
            (report && report.end_date) ||
            job.endDate ||
            null
        };

        if (
          await reportFileAlreadyImported(
            reportFile
          )
        ) {
          processed += 1;

          await finishReportJob(job.id, {
            status: "processed",
            fileName,
            providerStatus,
            reportId,
            alreadyImported: true
          });

          continue;
        }

        const csv =
          await downloadAccountReport(
            fileName
          );

        const receipts =
          parseAccountReport(csv);

        const created =
          await importReceipts(receipts);

        imported += created;
        pixFound += receipts.length;
        processed += 1;

        await finishReportJob(job.id, {
          status: "processed",
          fileName,
          providerStatus,
          reportId,
          rowsAccepted: receipts.length,
          imported: created
        });

        await markReportFileImported(
          reportFile,
          {
            rowsAccepted: receipts.length,
            imported: created,
            sourceTaskId: String(job.id)
          }
        );

        continue;
      }

      if (
        /^(failed|error|cancelled|canceled)$/i
          .test(providerStatus)
      ) {
        failed += 1;

        await finishReportJob(job.id, {
          status: "failed",
          providerStatus,
          reportId
        });

        continue;
      }

      if (job.status === "expired") {
        await reopenReportJob(job.id, {
          providerStatus,
          reportId,
          recoveredFromExpiredAt:
            job.finishedAt || null
        });
      } else {
        await markReportChecked(job.id, {
          providerStatus,
          reportId
        });
      }

      stillPending += 1;
    } catch (error) {
      // Job com problema (tarefa expirada de vez, erro do MP,
      // rede etc.): marca como falho e SEGUE para o próximo job
      // em vez de derrubar toda a sincronização.
      failed += 1;

      const status =
        error && error.status === 404
          ? "task_not_found"
          : "check_error";

      await finishReportJob(job.id, {
        status: "failed",
        providerStatus: status,
        providerError:
          (error && error.message) ||
          String(error)
      }).catch((persistError) => {
        console.error(
          "[pix/sync] falha ao marcar job com erro",
          job.id,
          persistError
        );
      });
    }
  }

  if (skippedJobs > 0) {
    stillPending += skippedJobs;
  }

  return {
    imported,
    pixFound,
    processed,
    failed,
    stillPending
  };
}

async function importLatestAvailableReport() {
  const reports =
    await searchAccountReports({
      createdWithinDays: 7,
      limit: 30
    });

  let imported = 0;
  let pixFound = 0;
  let processed = 0;

  for (const report of reports) {
    const fileName = String(
      (report && report.file_name) || ""
    ).trim();

    const providerStatus = String(
      (report && report.status) || ""
    );

    if (
      !fileName ||
      providerStatus.toLowerCase() !==
        "processed"
    ) {
      continue;
    }

    if (
      await reportFileAlreadyImported(report)
    ) {
      continue;
    }

    // Cada relatório candidato tem seu próprio try/catch: se o
    // Mercado Pago rejeitar UM arquivo específico (por exemplo,
    // relatórios gerados manualmente pelo painel do MP às vezes
    // respondem 400 "Error validating url..." ao serem baixados
    // por aqui), isso não pode derrubar a sincronização inteira
    // nem travar o processamento dos relatórios seguintes.
    try {
      const csv =
        await downloadAccountReport(fileName);

      const receipts =
        parseAccountReport(csv);

      const created =
        await importReceipts(receipts);

      await markReportFileImported(
        report,
        {
          rowsAccepted: receipts.length,
          imported: created,
          source: "report_search"
        }
      );

      imported += created;
      pixFound += receipts.length;
      processed += 1;
    } catch (error) {
      console.error(
        "[pix/sync] falha ao baixar/importar relatório",
        fileName,
        error
      );

      // Marca como "resolvido" mesmo tendo falhado, só para
      // parar de tentar baixar esse mesmo arquivo problemático
      // a cada sincronização. O detalhe do erro fica registrado
      // para investigação.
      await markReportFileImported(report, {
        rowsAccepted: 0,
        imported: 0,
        source: "report_search",
        downloadFailed: true,
        providerError:
          (error && error.message) ||
          String(error)
      }).catch((persistError) => {
        console.error(
          "[pix/sync] falha ao registrar relatório com erro",
          fileName,
          persistError
        );
      });
    }
  }

  return { imported, pixFound, processed };
}

function reportQuotaReached(error) {
  return (
    error &&
    error.status === 400 &&
    /max number of pending task achieved|more than 24 task/i
      .test(error.message || "")
  );
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

  const nextReportRequestAtMs = Number(
    state.nextReportRequestAtMs || 0
  );

  if (
    nextReportRequestAtMs > Date.now()
  ) {
    return {
      requested: false,
      pending: 0,
      limited: true,
      retryAt: new Date(
        nextReportRequestAtMs
      ).toISOString()
    };
  }

  const lastRequestedAtMs = Number(
    state.lastRequestedAtMs || 0
  );

  if (
    lastRequestedAtMs > 0 &&
    Date.now() - lastRequestedAtMs <
      REPORT_RETRY_AFTER_MS
  ) {
    return {
      requested: false,
      pending: 0
    };
  }

  const period = reportPeriod();
  let report;

  try {
    report =
      await requestAccountReport(period);
  } catch (error) {
    if (!reportQuotaReached(error)) {
      throw error;
    }

    const retryAtMs =
      Date.now() +
      REPORT_QUOTA_COOLDOWN_MS;

    await markReportRequestBlocked({
      nextReportRequestAtMs: retryAtMs,
      nextReportRequestAt:
        new Date(retryAtMs).toISOString(),
      providerError:
        error.message || String(error)
    });

    return {
      requested: false,
      pending: 0,
      limited: true,
      retryAt:
        new Date(retryAtMs).toISOString()
    };
  }

  await saveReportJob(report, period);

  return {
    requested: true,
    pending: 1,
    limited: false,
    reportId: String(report.id)
  };
}

module.exports = async (req, res) => {
  applyCors(
    req,
    res,
    ["GET", "POST", "OPTIONS"]
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (
    !["GET", "POST"].includes(req.method)
  ) {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      ok: false,
      error: "Método não permitido."
    });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      ok: false,
      error:
        "CRON_SECRET ainda não foi configurado no Vercel."
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
      Math.max(
        Number(req.query.minutes || 120),
        5
      ),
      10080
    );

    const payments =
      await searchPayments({ minutes });

    let pixApproved = 0;
    let imported = 0;

    for (const payment of payments) {
      const receipt =
        normalizePayment(payment);

      if (!receipt) {
        continue;
      }

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
      await processReadyReports(
        pendingJobs
      );

    imported += reportImport.imported;

    const availableReportImport =
      await importLatestAvailableReport();

    imported +=
      availableReportImport.imported;

    const reportsProcessed =
      reportImport.processed +
      availableReportImport.processed;

    const reportPixFound =
      reportImport.pixFound +
      availableReportImport.pixFound;

    const reportRequest =
      await requestReportIfNeeded(
        reportImport.stillPending,
        reportsProcessed
      );

    const reportPending =
      reportRequest.pending > 0 ||
      reportImport.stillPending > 0;

    await markSync({
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig:
        reportConfiguration.action,
      reportPixFound,
      reportsProcessed,
      reportsFailed:
        reportImport.failed,
      reportPending,
      reportLimited:
        Boolean(reportRequest.limited),
      reportRetryAt:
        reportRequest.retryAt || null
    });

    return res.status(200).json({
      ok: true,
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig:
        reportConfiguration.action,
      reportPixFound,
      reportsProcessed,
      reportsFailed:
        reportImport.failed,
      reportRequested:
        reportRequest.requested,
      reportPending,
      reportLimited:
        Boolean(reportRequest.limited),
      reportRetryAt:
        reportRequest.retryAt || null
    });
  } catch (error) {
    console.error("[pix/sync]", error);

    return res.status(500).json({
      ok: false,
      error:
        "Erro ao conferir pagamentos no Mercado Pago.",
      detail:
        error.message || String(error)
    });
  }
};
