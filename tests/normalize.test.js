const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePayment } = require("../utils/normalize");

test("aceita somente pagamento Pix aprovado", () => {
  const receipt = normalizePayment({
    id: 12345,
    status: "approved",
    payment_method_id: "pix",
    payment_type_id: "bank_transfer",
    transaction_amount: 38.9,
    date_approved: "2026-07-29T18:42:00-03:00",
    payer: {
      first_name: "Maria",
      last_name: "Silva"
    }
  });

  assert.equal(receipt.id, "mp_12345");
  assert.equal(receipt.payerName, "Maria Silva");
  assert.equal(receipt.amountCents, 3890);

  assert.equal(
    normalizePayment({
      id: 9,
      status: "pending",
      payment_method_id: "pix",
      transaction_amount: 10,
      date_created: "2026-07-29T18:42:00-03:00"
    }),
    null
  );

  assert.equal(
    normalizePayment({
      id: 10,
      status: "approved",
      payment_method_id: "visa",
      transaction_amount: 10,
      date_approved: "2026-07-29T18:42:00-03:00"
    }),
    null
  );
});
