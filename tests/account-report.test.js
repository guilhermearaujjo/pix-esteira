const test = require("node:test");
const assert = require("node:assert/strict");
const {
  configNeedsUpdate,
  parseAccountReport,
  parseDelimited,
  reportConfig
} = require("../utils/account-report");

test("converte uma entrada Pix do relatório em recebimento", () => {
  const csv = [
    "SOURCE_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_DATE;OPERATION_TAGS",
    "pix-123;bank_transfer;pix;SETTLEMENT;0,01;2026-07-30T15:10:00.000-03:00;0,01;2026-07-30T15:10:01.000-03:00;PIX"
  ].join("\n");

  const receipts = parseAccountReport(csv);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, "mp_pix-123");
  assert.equal(receipts[0].amountCents, 1);
  assert.equal(receipts[0].payerName, "Pix recebido");
  assert.equal(receipts[0].source, "Extrato Mercado Pago");
});

test("ignora cartão, saída e valores negativos", () => {
  const csv = [
    "SOURCE_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_DATE;OPERATION_TAGS",
    "card-1;credit_card;visa;SETTLEMENT;10.00;2026-07-30T15:10:00Z;9.50;2026-07-30T15:10:00Z;",
    "pix-out;bank_transfer;pix;PAYOUT;-20.00;2026-07-30T15:11:00Z;-20.00;2026-07-30T15:11:00Z;PIX"
  ].join("\n");

  assert.deepEqual(parseAccountReport(csv), []);
});

test("parser aceita campos CSV entre aspas", () => {
  const rows = parseDelimited(
    'SOURCE_ID;DESCRIPTION;TRANSACTION_AMOUNT\n1;"Texto; com separador";2.50'
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].DESCRIPTION, "Texto; com separador");
});

test("aceita valores com formatação brasileira ou internacional", () => {
  const header =
    "SOURCE_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_DATE;OPERATION_TAGS";
  const csv = [
    header,
    "br;bank_transfer;pix;SETTLEMENT;1.234,56;2026-07-30T15:10:00Z;1.234,56;2026-07-30T15:10:00Z;PIX",
    "us;bank_transfer;pix;SETTLEMENT;1,234.56;2026-07-30T15:11:00Z;1,234.56;2026-07-30T15:11:00Z;PIX"
  ].join("\n");

  const receipts = parseAccountReport(csv);
  assert.deepEqual(
    receipts.map((receipt) => receipt.amountCents),
    [123456, 123456]
  );
});

test("configuração preserva colunas existentes e adiciona as necessárias", () => {
  const existing = {
    file_name_prefix: "relatorio-atual",
    separator: ",",
    columns: [{ key: "DESCRIPTION" }, { key: "SOURCE_ID" }]
  };
  const config = reportConfig(existing);
  const keys = config.columns.map((column) => column.key);

  assert.equal(config.file_name_prefix, "relatorio-atual");
  assert.equal(config.separator, ",");
  assert(keys.includes("DESCRIPTION"));
  assert(keys.includes("PAYMENT_METHOD_TYPE"));
  assert.equal(configNeedsUpdate(existing), true);
  assert.equal(configNeedsUpdate(config), false);
});
