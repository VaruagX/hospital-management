// Razorpay gateway adapter. Credentials come ONLY from environment variables:
//   RAZORPAY_KEY_ID (public), RAZORPAY_KEY_SECRET (never leaves the server), RAZORPAY_WEBHOOK_SECRET.
// Signature verification is real HMAC-SHA256 with constant-time comparison. Only the three network calls
// (create order, refund) go through `client`, which tests replace with a stub.
const crypto = require("node:crypto");

const API = "https://api.razorpay.com/v1";

function creds() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  };
}

function isConfigured() {
  const c = creds();
  return Boolean(c.keyId && c.keySecret);
}

function publicKeyId() {
  return creds().keyId;
}

function safeEqualHex(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex), "utf8");
  const b = Buffer.from(String(givenHex || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Checkout success proof: HMAC_SHA256(order_id + "|" + payment_id, key_secret) must equal the signature. */
function verifyCheckoutSignature(orderId, paymentId, signature) {
  const { keySecret } = creds();
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook proof: HMAC_SHA256(raw request body, webhook_secret) must equal X-Razorpay-Signature. */
function verifyWebhookSignature(rawBody, signature) {
  const { webhookSecret } = creds();
  if (!webhookSecret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

async function call(path, body) {
  const { keyId, keySecret } = creds();
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json?.error?.description || `Razorpay request failed (${response.status})`);
    error.statusCode = 502;
    throw error;
  }
  return json;
}

const realClient = {
  createOrder: ({ amountPaise, receipt, notes }) =>
    call("/orders", { amount: amountPaise, currency: "INR", receipt, notes }),
  refund: ({ paymentId, amountPaise, notes }) =>
    call(`/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, notes }),
};

let client = realClient;
/** Test hook only. */
function setClient(stub) {
  client = stub || realClient;
}

module.exports = {
  createOrder: (args) => client.createOrder(args),
  refund: (args) => client.refund(args),
  isConfigured, publicKeyId, setClient, verifyCheckoutSignature, verifyWebhookSignature,
};
