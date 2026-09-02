import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at rest for platform tokens. The key never touches the database -
 * it lives only in TOKEN_ENCRYPTION_KEY (env). Losing the key means losing every
 * stored connection (accounts have to be reconnected) - that's the intended
 * tradeoff for keeping this dependency-free and auditable in ~40 lines.
 */
function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be set to a 32-byte hex string (64 hex chars). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.ciphertext, each base64 - simple to store as one TEXT column.
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptJson<T = unknown>(stored: string): T {
  const [ivB64, tagB64, dataB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted credential blob.");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
