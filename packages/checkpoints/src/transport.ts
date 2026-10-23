import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const INLINE_PAYLOAD_BYTES = 1024 * 1024;
export const payloadHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function encryptPayload(bytes: Uint8Array) {
  if (bytes.length > MAX_PAYLOAD_BYTES - 28)
    throw new Error("Worker payload exceeds 64 MiB.");
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    iv,
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    data,
    key: key.toString("base64url"),
    hash: payloadHash(data),
    size: data.length,
  };
}
export function decryptPayload(data: Uint8Array, key: string): Uint8Array {
  const bytes = Buffer.from(data);
  const decoded = Buffer.from(key, "base64url");
  if (
    decoded.length !== 32 ||
    bytes.length < 28 ||
    bytes.length > MAX_PAYLOAD_BYTES
  )
    throw new Error("Invalid encrypted worker payload.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decoded,
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return new Uint8Array(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
}
