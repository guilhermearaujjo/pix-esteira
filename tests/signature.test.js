const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  verifyWebhookSignature,
  webhookManifest
} = require("../utils/signature");

test("valida HMAC do Webhook do Mercado Pago", () => {
  const secret = "segredo-de-teste";
  const dataId = "AbC123";
  const requestId = "request-001";
  const timestamp = "1753812300";
  const hash = crypto
    .createHmac("sha256", secret)
    .update(webhookManifest(dataId, requestId, timestamp))
    .digest("hex");

  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${timestamp},v1=${hash}`,
      dataId,
      requestId,
      secret
    }),
    true
  );

  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${timestamp},v1=${hash}`,
      dataId: "outro-id",
      requestId,
      secret
    }),
    false
  );
});
