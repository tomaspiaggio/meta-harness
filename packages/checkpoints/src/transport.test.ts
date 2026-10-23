import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptPayload,
  encryptPayload,
  INLINE_PAYLOAD_BYTES,
  payloadHash,
} from "./transport";

test("large native/checkpoint transport encrypts bytes and authenticates every byte before decoding", () => {
  const plain = Buffer.from(
    JSON.stringify({
      message: "image native transcript",
      data: "private-state-".repeat(INLINE_PAYLOAD_BYTES / 10),
    }),
  );
  const encrypted = encryptPayload(plain);
  assert.ok(encrypted.size > INLINE_PAYLOAD_BYTES);
  assert.ok(!encrypted.data.includes(Buffer.from("private-state")));
  assert.equal(payloadHash(encrypted.data), encrypted.hash);
  assert.deepEqual(
    Buffer.from(decryptPayload(encrypted.data, encrypted.key)),
    plain,
  );
  const changed = Buffer.from(encrypted.data);
  changed[changed.length - 20] ^= 1;
  assert.throws(() => decryptPayload(changed, encrypted.key));
  assert.throws(() =>
    decryptPayload(encrypted.data, encryptPayload(Buffer.from("other")).key),
  );
});
