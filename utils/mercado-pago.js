const API_BASE = "https://api.mercadopago.com";

function getAccessToken() {
  const token = String(process.env.MP_ACCESS_TOKEN || "").trim();

  if (!token) {
    throw new Error("MP_ACCESS_TOKEN não configurado.");
  }

  return token;
}

async function mercadoPagoRequest(
  path,
  { method = "GET", body, responseType = "json" } = {}
) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      Accept:
        responseType === "text"
          ? "text/csv, text/plain, */*"
          : "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const raw = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Mercado Pago respondeu ${response.status}: ${raw.slice(0, 300)}`
    );

    error.status = response.status;
    throw error;
  }

  if (responseType === "text") {
    return raw;
  }

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Mercado Pago respondeu um JSON inválido.");
  }
}

async function mercadoPagoGet(path) {
  return mercadoPagoRequest(path);
}

async function getPayment(paymentId) {
  return mercadoPagoGet(
    `/v1/payments/${encodeURIComponent(paymentId)}`
  );
}

async function getOrder(orderId) {
  return mercadoPagoGet(
    `/v1/orders/${encodeURIComponent(orderId)}`
  );
}

function collectPaymentIds(value, result = new Set()) {
  if (!value || typeof value !== "object") {
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectPaymentIds(item, result));
    return result;
  }

  const explicitId = value.payment_id || value.paymentId;

  if (explicitId) {
    result.add(String(explicitId));
  }

  if (
    value.id &&
    (
      value.payment_method_id === "pix" ||
      value.payment_type_id === "bank_transfer"
    )
  ) {
    result.add(String(value.id));
  }

  Object.values(value).forEach((item) =>
    collectPaymentIds(item, result)
  );

  return result;
}

async function getPaymentsFromOrder(orderId) {
  const order = await getOrder(orderId);
  const paymentIds = [...collectPaymentIds(order)];

  return Promise.all(paymentIds.map(getPayment));
}

async function searchPayments({
  minutes = 120,
  maxPages = 3
} = {}) {
  const safeMinutes = Math.min(
    Math.max(Number(minutes) || 120, 5),
    10080
  );

  const end = new Date();
  const begin = new Date(
    end.getTime() - safeMinutes * 60_000
  );

  const payments = [];

  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({
      sort: "date_approved",
      criteria: "desc",
      range: "date_approved",
      begin_date: begin.toISOString(),
      end_date: end.toISOString(),
      limit: "50",
      offset: String(page * 50)
    });

    const data = await mercadoPagoGet(
      `/v1/payments/search?${query}`
    );

    const pageItems = Array.isArray(data.results)
      ? data.results
      : [];

    payments.push(...pageItems);

    if (pageItems.length < 50) {
      break;
    }
  }

  return payments;
}

async function getAccountReportConfig() {
  try {
    return await mercadoPagoGet(
      "/v1/account/bank_report/config"
    );
  } catch (error) {
    const configurationMissing =
      error.status === 404 ||
      (
        error.status === 400 &&
        /config_not_found_for_user|configuration not found for user/i.test(
          error.message || ""
        )
      );

    if (configurationMissing) {
      return null;
    }

    throw error;
  }
}

async function createAccountReportConfig(config) {
  return mercadoPagoRequest(
    "/v1/account/bank_report/config",
    {
      method: "POST",
      body: config
    }
  );
}

async function updateAccountReportConfig(config) {
  return mercadoPagoRequest(
    "/v1/account/bank_report/config",
    {
      method: "PUT",
      body: config
    }
  );
}

async function requestAccountReport({
  beginDate,
  endDate
}) {
  const normalizeReportDate = (value) =>
    new Date(value)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");

  const begin = normalizeReportDate(beginDate);
  const end = normalizeReportDate(endDate);

  const created = await mercadoPagoRequest(
    "/v1/account/bank_report",
    {
      method: "POST",
      body: {
        begin_date: begin,
        end_date: end
      }
    }
  );

  if (created && created.id != null) {
    return created;
  }

  // Algumas contas respondem 202 sem corpo. Nesse caso, busca na
  // listagem a entrada mais recente criada manualmente para obter
  // o id e acompanhar o processamento.
  const result = await mercadoPagoGet(
    "/v1/account/bank_report/list"
  );

  const reports = Array.isArray(result)
    ? result
    : result && Array.isArray(result.results)
      ? result.results
      : [];

  const newest = reports
    .filter((report) => report && report.id != null)
    .sort((a, b) => {
      const time = (report) =>
        new Date(
          report.generation_date ||
            report.last_modified ||
            0
        ).getTime() || 0;
      return time(b) - time(a);
    })[0];

  if (!newest) {
    throw new Error(
      "Mercado Pago aceitou o pedido de relatório mas não retornou o identificador."
    );
  }

  return newest;
}

async function getAccountReportTask(taskId) {
  // O bank_report nao expoe um endpoint /task/{id}. O status
  // de um relatorio solicitado e conferido pela propria listagem:
  // procuramos a entrada cujo id (ou report_id) bate com o job.
  const wanted = String(taskId);

  const result = await mercadoPagoGet(
    "/v1/account/bank_report/list"
  );

  const reports = Array.isArray(result)
    ? result
    : result && Array.isArray(result.results)
      ? result.results
      : [];

  const found = reports.find((report) => {
    if (!report) return false;
    const id = report.id != null ? String(report.id) : "";
    const reportId =
      report.report_id != null ? String(report.report_id) : "";
    return id === wanted || reportId === wanted;
  });

  if (!found) {
    const error = new Error(
      `Relatório ${wanted} não encontrado na listagem do Mercado Pago.`
    );
    error.status = 404;
    throw error;
  }

  return found;
}

async function searchAccountReports({
  createdWithinDays = 7,
  limit = 30
} = {}) {
  const safeDays = Math.min(
    Math.max(Number(createdWithinDays) || 7, 1),
    30
  );

  const safeLimit = Math.min(
    Math.max(Number(limit) || 30, 1),
    100
  );

  // Endpoint oficial para listar relatorios ja gerados do
  // relatorio de Dinheiro em conta (bank_report),
  // que e o unico que registra Pix recebidos direto por chave.
  // Nao aceita parametros de busca; o filtro por data e feito
  // aqui, do nosso lado.
  const result = await mercadoPagoGet(
    "/v1/account/bank_report/list"
  );

  const reports = Array.isArray(result)
    ? result
    : result && Array.isArray(result.results)
      ? result.results
      : [];

  const cutoffMs =
    Date.now() - safeDays * 24 * 60 * 60_000;

  const reportDateMs = (report) => {
    const raw =
      (report && report.generation_date) ||
      (report && report.last_modified) ||
      (report && report.end_date) ||
      (report && report.begin_date) ||
      "";

    const time = new Date(raw).getTime();
    return Number.isFinite(time) ? time : 0;
  };

  return reports
    .filter(
      (report) => reportDateMs(report) >= cutoffMs
    )
    .sort(
      (a, b) => reportDateMs(b) - reportDateMs(a)
    )
    .slice(0, safeLimit);
}

async function downloadAccountReport(fileName) {
  return mercadoPagoRequest(
    `/v1/account/bank_report/${encodeURIComponent(fileName)}`,
    {
      responseType: "text"
    }
  );
}

module.exports = {
  createAccountReportConfig,
  downloadAccountReport,
  getAccountReportConfig,
  getAccountReportTask,
  getPayment,
  getPaymentsFromOrder,
  requestAccountReport,
  searchAccountReports,
  searchPayments,
  updateAccountReportConfig
};
