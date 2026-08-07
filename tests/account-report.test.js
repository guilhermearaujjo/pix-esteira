const test = require("node:test");
const assert = require("node:assert/strict");
const {
  configNeedsUpdate,
  parseAccountReport,
  parseDelimited,
  reportConfig
} = require("../utils/account-report");

const HEADER =
  "DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID";

test("converte um Pix recebido do relatório de liberações em recebimento", () => {
  const csv = [
    HEADER,
    "2026-08-07T16:00:35.000-03:00;171683166589;payment;0.01;0.00;0.01;0.00;0.00;pix;2026-08-07T16:00:35.000-03:00;;;0.06;bank_transfer;"
  ].join("\n");

  const receipts = parseAccountReport(csv);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, "mp_171683166589");
  assert.equal(receipts[0].amountCents, 1);
  assert.equal(receipts[0].payerName, "Pix recebido");
  assert.equal(receipts[0].source, "Extrato Mercado Pago");
});

test("ignora saldo inicial, movimentações internas e débitos", () => {
  const csv = [
    HEADER,
    "2026-07-15T00:00:00.000-03:00;;;0.00;0.00;0.00;0.00;0.00;;;;;0.00;;",
    "2026-07-19T13:16:01.000-03:00;168694364037;reserve_for_payout;0.00;200.00;-200.00;0.00;0.00;available_money;2026-07-19T13:16:01.000-03:00;;;0.00;;",
    "2026-07-19T13:16:02.000-03:00;168694364037;reserve_for_payout;200.00;0.00;200.00;0.00;0.00;available_money;2026-07-19T13:16:02.000-03:00;;;200.00;;",
    "2026-07-20T10:00:00.000-03:00;999;payout;0.00;50.00;-50.00;0.00;0.00;pix;2026-07-20T10:00:00.000-03:00;;;150.00;bank_transfer;"
  ].join("\n");

  assert.deepEqual(parseAccountReport(csv), []);
});

test("aceita Pix do checkout com desconto de taxa (valor líquido)", () => {
  const csv = [
    HEADER,
    "2026-07-19T12:48:09.000-03:00;168691345877;payment;199.00;0.00;200.00;1.00;0.00;pix;2026-07-19T12:48:09.000-03:00;;;199.00;bank_transfer;"
  ].join("\n");

  const receipts = parseAccountReport(csv);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountCents, 19900);
});

test("parser aceita campos CSV entre aspas", () => {
  const rows = parseDelimited(
    'SOURCE_ID;DESCRIPTION;GROSS_AMOUNT\n1;"Texto; com separador";2.50'
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].DESCRIPTION, "Texto; com separador");
});

test("aceita valores com formatação brasileira ou internacional", () => {
  const csv = [
    HEADER,
    "2026-07-30T15:10:00Z;br;payment;1.234,56;0,00;1.234,56;0,00;0,00;pix;2026-07-30T15:10:00Z;;;1.234,56;bank_transfer;",
    "2026-07-30T15:11:00Z;us;payment;1,234.56;0.00;1,234.56;0.00;0.00;pix;2026-07-30T15:11:00Z;;;1,234.56;bank_transfer;"
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
  assert(keys.includes("NET_CREDIT_AMOUNT"));
  assert(keys.includes("PAYMENT_METHOD_TYPE"));
  assert.equal(configNeedsUpdate(existing), true);
  assert.equal(configNeedsUpdate(config), false);
});
