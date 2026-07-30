const API_BASE = "https://api.mercadopago.com";

function getAccessToken() {
  const token = String(process.env.MP_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("MP_ACCESS_TOKEN não configurado.");
  return token;
}

async function mercadoPagoGet(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Mercado Pago respondeu ${response.status}: ${detail.slice(0, 180)}`
    );
  }

  return response.json();
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

module.exports = {
  getPayment,
  getPaymentsFromOrder,
  searchPayments
};
