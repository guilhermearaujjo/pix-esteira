const crypto = require("node:crypto");

function parseSignature(value) {
  return Object.fromEntries(
    String(value || "")
      .split(",")
      .map((part) => part.trim().split("=", 2))
      .filter(([key, item]) => key && item)
  );
}

function webhookManifest(dataId, requestId, timestamp) {
  let manifest = "";
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  if (timestamp) manifest += `ts:${timestamp};`;
  return manifest;
}

function verifyWebhookSignature({ signature, dataId, requestId, secret }) {
  if (!signature || !secret) return false;
  const parsed = parseSignature(signature);
  if (!parsed.ts || !parsed.v1) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(webhookManifest(dataId, requestId, parsed.ts))
    .digest("hex");

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(parsed.v1);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

module.exports = { verifyWebhookSignature, webhookManifest };
