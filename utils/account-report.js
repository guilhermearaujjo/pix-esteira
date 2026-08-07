const crypto = require("node:crypto");

// Colunas do relatório de LIBERAÇÕES / Dinheiro em conta
// (release_report). É este relatório — e não o de Liquidações —
// que registra Pix recebidos direto na conta por chave.
const REQUIRED_COLUMNS = [
  "DATE",
  "SOURCE_ID",
  "DESCRIPTION",
  "NET_CREDIT_AMOUNT",
  "NET_DEBIT_AMOUNT",
  "GROSS_AMOUNT",
  "MP_FEE_AMOUNT",
  "PAYMENT_METHOD",
  "PAYMENT_METHOD_TYPE",
  "TRANSACTION_APPROVAL_DATE"
];

function reportConfig(existing = null) {
  const previous = existing && typeof existing === "object" ? existing : {};
  const previousColumns = Array.isArray(previous.columns)
    ? previous.columns
        .map((column) => String(column && column.key ? column.key : "").trim())
        .filter(Boolean)
    : [];
  const columnKeys = [...new Set([...previousColumns, ...REQUIRED_COLUMNS])];

  // Campos aceitos pela configuração do release_report. Preserva
  // o que já existe na conta e só garante nossas colunas.
  return {
    file_name_prefix: String(
      previous.file_name_prefix || "pix-esteira"
    ).slice(0, 60),
    include_withdrawal_at_end: Boolean(previous.include_withdrawal_at_end),
    execute_after_withdrawal: Boolean(previous.execute_after_withdrawal),
    display_timezone: String(previous.display_timezone || "GMT-03"),
    separator: previous.separator === "," ? "," : ";",
    frequency:
      previous.frequency && typeof previous.frequency === "object"
        ? previous.frequency
        : { hour: 0, type: "monthly", value: 1 },
    ...(Array.isArray(previous.notification_email_list) &&
    previous.notification_email_list.length
      ? { notification_email_list: previous.notification_email_list }
      : {}),
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
        row.DATE,
        row.TRANSACTION_APPROVAL_DATE,
        row.NET_CREDIT_AMOUNT,
        row.GROSS_AMOUNT,
        row.PAYMENT_METHOD,
        row.DESCRIPTION
      ].join("|")
    )
    .digest("hex")
    .slice(0, 28);
}

// Descrições de linha que representam dinheiro ENTRANDO por Pix.
// Linhas internas (reserve_for_payout, payout, withdrawal etc.)
// nunca casam com o filtro de método Pix, mas a allowlist é uma
// segunda barreira contra estornos e movimentações internas.
const CREDIT_DESCRIPTIONS = /^(payment|transfer|pix_transfer|pix)$/i;

function normalizeAccountReportRow(row) {
  const description = String(row.DESCRIPTION || "").trim();
  const methodType = String(row.PAYMENT_METHOD_TYPE || "").toLowerCase();
  const method = String(row.PAYMENT_METHOD || "").toLowerCase();

  const isPix =
    method === "pix" ||
    methodType === "pix" ||
    methodType === "bank_transfer";

  const credit = numberFromReport(row.NET_CREDIT_AMOUNT);
  const gross = numberFromReport(row.GROSS_AMOUNT);
  const amount = credit > 0 ? credit : gross;

  const approvedAtRaw = String(
    row.TRANSACTION_APPROVAL_DATE || row.DATE || ""
  ).trim();
  const approvedAt = new Date(approvedAtRaw);

  if (
    credit <= 0 ||
    !isPix ||
    !CREDIT_DESCRIPTIONS.test(description) ||
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
