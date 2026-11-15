import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function encryptWebhookSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptWebhookSecret(value: string, key: Buffer): string {
  const [encodedIv, encodedTag, encodedCiphertext, ...extra] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra.length > 0) {
    throw new Error("Stored webhook secret is malformed");
  }
  const iv = Buffer.from(encodedIv, "base64url");
  const tag = Buffer.from(encodedTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Stored webhook secret is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const digest = signatureDigest(secret, timestamp, body);
  return `t=${timestamp},v1=${digest}`;
}

function signatureDigest(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function verifyWebhookSignature(
  signature: string,
  secret: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300
): boolean {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const suppliedDigest = match[2];
  if (!suppliedDigest) return false;
  const expected = Buffer.from(signatureDigest(secret, timestamp, body), "hex");
  const supplied = Buffer.from(suppliedDigest, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
