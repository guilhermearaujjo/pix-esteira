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

// Contas em que o Mercado Pago não permite GERAR o extrato via
// API (POST responde 404 not_found). Listar e baixar relatórios
// continuam funcionando; só a solicitação fica em pausa longa.
const REPORT_UNSUPPORTED_COOLDOWN_MS =
  7 * 24 * 60 * 60_000;

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

// Detecta erros de credencial/permissão do Mercado Pago
// (token inválido, expirado, ou aplicação sem o escopo
// necessário — ex.: "Relatórios" para o settlement report).
function mpPermissionError(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || 0);
  const message = String(error.message || "");

  return (
    status === 401 ||
    status === 403 ||
    /PA_UNAUTHORIZED|policy.?agent|unauthorized|invalid.?token|expired.?token/i
      .test(message)
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
  const REPORT_JOBS_PER_RUN = 6;
  const jobsToCheck = pendingJobs.slice(
    0,
    REPORT_JOBS_PER_RUN
  );
  const skippedJobs =
    pendingJobs.length - jobsToCheck.length;

  for (const job of jobsToCheck) {
    // Cada job tem seu próprio try/catch: um erro em UM job
    // nunca derruba a sincronização inteira.
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
      // Erro de permissão vale para a conta toda: não adianta
      // tentar os próximos jobs — propaga para o fail-soft
      // do pipeline de relatórios.
      if (mpPermissionError(error)) {
        throw error;
      }

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
  let candidates = 0;
  const listed = reports.length;

  for (const report of reports) {
    const fileName = String(
      (report && report.file_name) || ""
    ).trim();

    const providerStatus = String(
      (report && report.status) || ""
    ).toLowerCase();

    // Um relatório é baixável quando já tem arquivo gerado
    // (file_name) e não está claramente em preparação ou com
    // falha. Aceitar apenas o status "processed" fazia o MP ser
    // ignorado quando respondia variações como "available".
    if (!fileName) {
      continue;
    }

    if (
      /pending|processing|in_progress|waiting|queue|failed|error|cancel/.test(
        providerStatus
      )
    ) {
      continue;
    }

    candidates += 1;

    if (
      await reportFileAlreadyImported(report)
    ) {
      continue;
    }

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
      if (mpPermissionError(error)) {
        throw error;
      }

      console.error(
        "[pix/sync] falha ao baixar/importar relatório",
        fileName,
        error
      );

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

  return {
    imported,
    pixFound,
    processed,
    listed,
    candidates
  };
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
    if (error && error.status === 404) {
      const retryAtMs =
        Date.now() +
        REPORT_UNSUPPORTED_COOLDOWN_MS;

      await markReportRequestBlocked({
        nextReportRequestAtMs: retryAtMs,
        nextReportRequestAt:
          new Date(retryAtMs).toISOString(),
        providerError:
          "Geração de extrato via API indisponível para esta conta (404). " +
          (error.message || "")
      });

      // Sem aviso no painel: os Pix chegam pela busca de
      // pagamentos e pelo webhook; relatórios gerados
      // manualmente continuam sendo importados pela listagem.
      return {
        requested: false,
        pending: 0
      };
    }

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

// ---------------------------------------------------------------
// PIPELINE DE RELATÓRIOS (fail-soft)
//
// Todo o fluxo de extrato/settlement report do Mercado Pago roda
// aqui dentro, protegido: se a conta não tiver a permissão de
// "Relatórios" (erro 401/403 PolicyAgent), ou qualquer outra
// etapa do extrato falhar, a sincronização principal de
// pagamentos NÃO é derrubada. O painel recebe ok:true com um
// aviso em `reportWarning` em vez de um erro 500.
// ---------------------------------------------------------------
async function runReportPipeline() {
  const result = {
    imported: 0,
    pixFound: 0,
    processed: 0,
    failed: 0,
    configAction: "skipped",
    listed: 0,
    candidates: 0,
    requested: false,
    pending: false,
    limited: false,
    retryAt: null,
    warning: null,
    permissionDenied: false
  };

  try {
    const reportConfiguration =
      await ensureReportConfiguration();

    result.configAction =
      reportConfiguration.action;

    const pendingJobs =
      await listPendingReportJobs();

    const reportImport =
      await processReadyReports(
        pendingJobs
      );

    result.imported +=
      reportImport.imported;
    result.pixFound +=
      reportImport.pixFound;
    result.processed +=
      reportImport.processed;
    result.failed = reportImport.failed;

    const availableReportImport =
      await importLatestAvailableReport();

    result.imported +=
      availableReportImport.imported;
    result.pixFound +=
      availableReportImport.pixFound;
    result.processed +=
      availableReportImport.processed;
    result.listed =
      availableReportImport.listed;
    result.candidates =
      availableReportImport.candidates;

    const reportRequest =
      await requestReportIfNeeded(
        reportImport.stillPending,
        result.processed
      );

    result.requested =
      Boolean(reportRequest.requested);
    result.limited =
      Boolean(reportRequest.limited);
    result.retryAt =
      reportRequest.retryAt || null;
    result.pending =
      reportRequest.pending > 0 ||
      reportImport.stillPending > 0;

    return result;
  } catch (error) {
    console.error(
      "[pix/sync] pipeline de relatórios falhou",
      error
    );

    result.permissionDenied =
      mpPermissionError(error);

    result.warning =
      result.permissionDenied
        ? "A conta do Mercado Pago não liberou acesso aos relatórios de extrato para este token (permissão \"Relatórios\" da aplicação). Os pagamentos Pix do checkout continuam sendo sincronizados normalmente."
        : "O extrato do Mercado Pago falhou nesta rodada, mas os pagamentos Pix foram conferidos normalmente. Detalhe: " +
          ((error && error.message) ||
            String(error)).slice(0, 200);

    // Garante que o painel não fique em polling esperando um
    // relatório que nunca vai chegar.
    result.pending = false;
    result.limited = false;
    result.retryAt = null;

    return result;
  }
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

  const minutes = Math.min(
    Math.max(
      Number(req.query.minutes || 120),
      5
    ),
    10080
  );

  // -------------------------------------------------------------
  // 1) Sincronização principal: busca de pagamentos aprovados.
  //    Se ISTO falhar, aí sim o botão deve mostrar erro — e com
  //    uma mensagem que diz exatamente o que verificar.
  // -------------------------------------------------------------
  let payments;

  try {
    payments =
      await searchPayments({ minutes });
  } catch (error) {
    console.error(
      "[pix/sync] busca de pagamentos falhou",
      error
    );

    if (mpPermissionError(error)) {
      return res.status(502).json({
        ok: false,
        error:
          "O Mercado Pago recusou o token de acesso.",
        detail:
          "Verifique a variável MP_ACCESS_TOKEN no Vercel: use o Access Token de PRODUÇÃO da conta correta, gerado em uma aplicação com permissão de leitura de pagamentos. Resposta do MP: " +
          ((error && error.message) ||
            String(error)).slice(0, 200)
      });
    }

    return res.status(502).json({
      ok: false,
      error:
        "Erro ao conferir pagamentos no Mercado Pago.",
      detail:
        (error && error.message) ||
        String(error)
    });
  }

  try {
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

    // -----------------------------------------------------------
    // 2) Pipeline de relatórios: totalmente fail-soft.
    // -----------------------------------------------------------
    const report =
      await runReportPipeline();

    imported += report.imported;

    await markSync({
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig: report.configAction,
      reportPixFound: report.pixFound,
      reportsProcessed: report.processed,
      reportsFailed: report.failed,
      reportPending: report.pending,
      reportLimited: report.limited,
      reportRetryAt: report.retryAt,
      reportWarning: report.warning,
      reportsListed: report.listed,
      reportCandidates: report.candidates,
      reportPermissionDenied:
        report.permissionDenied
    });

    return res.status(200).json({
      ok: true,
      checkedPayments: payments.length,
      pixApproved,
      imported,
      minutes,
      reportConfig: report.configAction,
      reportPixFound: report.pixFound,
      reportsProcessed: report.processed,
      reportsFailed: report.failed,
      reportRequested: report.requested,
      reportPending: report.pending,
      reportLimited: report.limited,
      reportRetryAt: report.retryAt,
      reportWarning: report.warning,
      reportsListed: report.listed,
      reportCandidates: report.candidates
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
