const API_BASE = "https://api.mercadopago.com";

function getAccessToken() {
  const token = String(process.env.MP_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("MP_ACCESS_TOKEN não configurado.");
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
      Accept: responseType === "text" ? "text/csv, text/plain, */*" : "application/json",
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

  if (responseType === "text") return raw;
  if (!raw.trim()) return null;

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
  return mercadoPagoGet(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

async function getOrder(orderId) {
  return mercadoPagoGet(`/v1/orders/${encodeURIComponent(orderId)}`);
}

function collectPaymentIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;

  if (Array.isArray(value)) {
    value.forEach((item) => collectPaymentIds(item, result));
    return result;
  }

  const explicitId = value.payment_id || value.paymentId;
  if (explicitId) result.add(String(explicitId));

  if (
    value.id &&
    (value.payment_method_id === "pix" ||
      value.payment_type_id === "bank_transfer")
  ) {
    result.add(String(value.id));
  }

  Object.values(value).forEach((item) => collectPaymentIds(item, result));
  return result;
}

async function getPaymentsFromOrder(orderId) {
  const order = await getOrder(orderId);
  const paymentIds = [...collectPaymentIds(order)];
  return Promise.all(paymentIds.map(getPayment));
}

async function searchPayments({ minutes = 120, maxPages = 3 } = {}) {
  const safeMinutes = Math.min(Math.max(Number(minutes) || 120, 5), 10080);
  const end = new Date();
  const begin = new Date(end.getTime() - safeMinutes * 60_000);
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

    const data = await mercadoPagoGet(`/v1/payments/search?${query}`);
    const pageItems = Array.isArray(data.results) ? data.results : [];
    payments.push(...pageItems);
    if (pageItems.length < 50) break;
  }

  return payments;
}

async function getAccountReportConfig() {
  try {
    return await mercadoPagoGet("/v1/account/settlement_report/config");
  } catch (error) {
    const configurationMissing =
      error.status === 404 ||
      (error.status === 400 &&
        /config_not_found_for_user|configuration not found for user/i.test(
          error.message || ""
        ));
    if (configurationMissing) return null;
    throw error;
  }
}

async function createAccountReportConfig(config) {
  return mercadoPagoRequest("/v1/account/settlement_report/config", {
    method: "POST",
    body: config
  });
}

async function updateAccountReportConfig(config) {
  return mercadoPagoRequest("/v1/account/settlement_report/config", {
    method: "PUT",
    body: config
  });
}

async function requestAccountReport({ beginDate, endDate }) {
  return mercadoPagoRequest("/v1/account/settlement_report", {
    method: "POST",
    body: {
      begin_date: beginDate,
      end_date: endDate
    }
  });
}

async function listAccountReports() {
  const result = await mercadoPagoGet("/v1/account/settlement_report/list");
  return Array.isArray(result) ? result : [];
}

async function downloadAccountReport(fileName) {
  return mercadoPagoRequest(
    `/v1/account/settlement_report/${encodeURIComponent(fileName)}`,
    { responseType: "text" }
  );
}

module.exports = {
  createAccountReportConfig,
  downloadAccountReport,
  getAccountReportConfig,
  getPayment,
  getPaymentsFromOrder,
  listAccountReports,
  requestAccountReport,
  updateAccountReportConfig,
  searchPayments
};
