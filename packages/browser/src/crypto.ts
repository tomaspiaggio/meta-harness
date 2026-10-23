import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
} from "node:crypto";

export interface EncryptedFrame {
  publicKey: string;
  iv: string;
  ciphertext: string;
}
export function encryptBytes(
  key: Uint8Array,
  bytes: Uint8Array,
): { iv: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}
export function decryptBytes(
  key: Uint8Array,
  value: { iv: string; ciphertext: string },
): Uint8Array {
  const iv = Buffer.from(value.iv, "base64");
  const data = Buffer.from(value.ciphertext, "base64");
  if (iv.length !== 12 || data.length < 16)
    throw new Error("Invalid encrypted browser payload.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(data.subarray(-16));
  return new Uint8Array(
    Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]),
  );
}
export function browserPeer(publicKey: string) {
  const peer = createECDH("prime256v1");
  peer.generateKeys();
  const key = peer.computeSecret(Buffer.from(publicKey, "base64"));
  return { key, publicKey: peer.getPublicKey().toString("base64") };
}
export function sealState(key: string, state: unknown): string {
  return JSON.stringify(
    encryptBytes(
      Buffer.from(key, "base64"),
      Buffer.from(JSON.stringify(state)),
    ),
  );
}
export function openState<T>(key: string, state: string): T {
  return JSON.parse(
    Buffer.from(
      decryptBytes(Buffer.from(key, "base64"), JSON.parse(state)),
    ).toString("utf8"),
  );
}
