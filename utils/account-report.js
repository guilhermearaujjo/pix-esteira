const crypto = require("node:crypto");

const REQUIRED_COLUMNS = [
  "SOURCE_ID",
  "PAYMENT_METHOD_TYPE",
  "PAYMENT_METHOD",
  "TRANSACTION_TYPE",
  "TRANSACTION_AMOUNT",
  "TRANSACTION_CURRENCY",
  "TRANSACTION_DATE",
  "SETTLEMENT_NET_AMOUNT",
  "SETTLEMENT_DATE",
  "OPERATION_TAGS"
];

function reportConfig(existing = null) {
  const previous = existing && typeof existing === "object" ? existing : {};
  const previousColumns = Array.isArray(previous.columns)
    ? previous.columns
        .map((column) => String(column && column.key ? column.key : "").trim())
        .filter(Boolean)
    : [];
  const columnKeys = [...new Set([...previousColumns, ...REQUIRED_COLUMNS])];

  return {
    file_name_prefix: String(
      previous.file_name_prefix || "pix-esteira"
    ).slice(0, 60),
    show_fee_prevision: Boolean(previous.show_fee_prevision),
    show_chargeback_cancel:
      previous.show_chargeback_cancel === undefined
        ? true
        : Boolean(previous.show_chargeback_cancel),
    coupon_detailed: Boolean(previous.coupon_detailed),
    include_withdraw: Boolean(previous.include_withdraw),
    shipping_detail: Boolean(previous.shipping_detail),
    refund_detailed: Boolean(previous.refund_detailed),
    display_timezone: String(previous.display_timezone || "GMT-03"),
    header_language: String(previous.header_language || "pt"),
    separator: previous.separator === "," ? "," : ";",
    frequency:
      previous.frequency && typeof previous.frequency === "object"
        ? previous.frequency
        : { hour: 0, type: "monthly", value: 1 },
    columns: columnKeys.map((key) => ({ key }))
  };
}

function configNeedsUpdate(existing) {
  if (!existing) return true;
  const present = new Set(
    (Array.isArray(existing.columns) ? existing.columns : []).map((column) =>
      String(column && column.key ? column.key : "").trim()
    )
  );
  return REQUIRED_COLUMNS.some((key) => !present.has(key));
}

function detectSeparator(csv) {
  const firstLine = String(csv || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ";" : ",";
}

function parseDelimited(csv, separator = detectSeparator(csv)) {
  const text = String(csv || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === separator) {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, "").trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.replace(/\r$/, "").trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.toUpperCase());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))
  );
}

function numberFromReport(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;

  let normalized = raw;
  if (raw.includes(",") && raw.includes(".")) {
    normalized =
      raw.lastIndexOf(",") > raw.lastIndexOf(".")
        ? raw.replace(/\./g, "").replace(",", ".")
        : raw.replace(/,/g, "");
  } else {
    normalized = raw.replace(",", ".");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function safeSourceId(row) {
  const supplied = String(row.SOURCE_ID || "").trim();
  if (supplied) return supplied;

  return crypto
    .createHash("sha256")
    .update(
      [
        row.TRANSACTION_DATE,
        row.SETTLEMENT_DATE,
        row.TRANSACTION_AMOUNT,
        row.SETTLEMENT_NET_AMOUNT,
        row.PAYMENT_METHOD,
        row.TRANSACTION_TYPE
      ].join("|")
    )
    .digest("hex")
    .slice(0, 28);
}

function normalizeAccountReportRow(row) {
  const transactionType = String(row.TRANSACTION_TYPE || "").toUpperCase();
  const methodType = String(row.PAYMENT_METHOD_TYPE || "").toLowerCase();
  const method = String(row.PAYMENT_METHOD || "").toLowerCase();
  const tags = String(row.OPERATION_TAGS || "").toUpperCase();

  const isIncoming = transactionType === "SETTLEMENT";
  const isPix =
    method === "pix" ||
    methodType === "pix" ||
    methodType === "bank_transfer" ||
    tags.includes("PIX");

  const netAmount = numberFromReport(row.SETTLEMENT_NET_AMOUNT);
  const grossAmount = numberFromReport(row.TRANSACTION_AMOUNT);
  const amount = netAmount > 0 ? netAmount : grossAmount;
  const approvedAtRaw = String(
    row.SETTLEMENT_DATE || row.TRANSACTION_DATE || ""
  ).trim();
  const approvedAt = new Date(approvedAtRaw);

  if (
    !isIncoming ||
    !isPix ||
    amount <= 0 ||
    !approvedAtRaw ||
    Number.isNaN(approvedAt.getTime())
  ) {
    return null;
  }

  const sourceId = safeSourceId(row);
  const documentId = sourceId.replace(/[/.]/g, "_");

  return {
    id: `mp_${documentId}`,
    provider: "MERCADO_PAGO",
    providerPaymentId: sourceId,
    payerName: "Pix recebido",
    amountCents: Math.round(amount * 100),
    approvedAt: approvedAt.toISOString(),
    approvedAtMs: approvedAt.getTime(),
    source: "Extrato Mercado Pago",
    paymentMethodId: method || "pix",
    paymentTypeId: methodType || "bank_transfer",
    providerStatus: "approved"
  };
}

function parseAccountReport(csv) {
  return parseDelimited(csv)
    .map(normalizeAccountReportRow)
    .filter(Boolean);
}

module.exports = {
  REQUIRED_COLUMNS,
  configNeedsUpdate,
  detectSeparator,
  normalizeAccountReportRow,
  parseAccountReport,
  parseDelimited,
  reportConfig
};
