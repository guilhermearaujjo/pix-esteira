function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNested(object, ...path) {
  let value = object;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function resolvePayerName(payment) {
  const firstName = readText(readNested(payment, "payer", "first_name"));
  const lastName = readText(readNested(payment, "payer", "last_name"));
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (fullName) return fullName;

  const additionalFirst = readText(
    readNested(payment, "additional_info", "payer", "first_name")
  );
  const additionalLast = readText(
    readNested(payment, "additional_info", "payer", "last_name")
  );
  const additionalName = [additionalFirst, additionalLast]
    .filter(Boolean)
    .join(" ");

  return (
    additionalName ||
    readText(readNested(payment, "payer", "email")) ||
    readText(readNested(payment, "metadata", "payer_name")) ||
    "Pagador não informado"
  );
}

function resolveSource(payment) {
  const deviceId = readText(payment.device_id);
  const pointType = readText(
    readNested(payment, "point_of_interaction", "type")
  );
  const pointSubtype = readText(
    readNested(payment, "point_of_interaction", "sub_type")
  );

  if (deviceId || /point|pos/i.test(`${pointType} ${pointSubtype}`)) {
    return "Maquininha / Point";
  }
  if (pointType) return "QR / chave Pix";
  return "Mercado Pago";
}

function normalizePayment(payment) {
  const status = readText(payment && payment.status).toLowerCase();
  const paymentMethodId = readText(
    payment && payment.payment_method_id
  ).toLowerCase();

  if (status !== "approved" || paymentMethodId !== "pix") return null;

  const providerPaymentId = String(payment.id || "").trim();
  const amount = Number(payment.transaction_amount || 0);
  const approvedAtRaw =
    readText(payment.date_approved) || readText(payment.date_created);
  const approvedAt = new Date(approvedAtRaw);

  if (!providerPaymentId || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (!approvedAtRaw || Number.isNaN(approvedAt.getTime())) return null;

  return {
    id: `mp_${providerPaymentId}`,
    provider: "MERCADO_PAGO",
    providerPaymentId,
    payerName: resolvePayerName(payment),
    amountCents: Math.round(amount * 100),
    approvedAt: approvedAt.toISOString(),
    approvedAtMs: approvedAt.getTime(),
    source: resolveSource(payment),
    paymentMethodId,
    paymentTypeId: readText(payment.payment_type_id).toLowerCase() || null,
    providerStatus: status
  };
}

module.exports = { normalizePayment };
