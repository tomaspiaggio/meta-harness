import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretRedactor } from "../apps/worker/src/redaction.ts";

test("streamed secrets are redacted even when every chunk splits inside a credential", () => {
  for (let width = 1; width < 35; width++) {
    const redactor = new SecretRedactor([
      "secret-credential-123",
      "other-key-456",
    ]);
    const text = "Before secret-credential-123 then other-key-456 after";
    let result = "";
    for (let index = 0; index < text.length; index += width)
      result += redactor.push(text.slice(index, index + width));
    result += redactor.push("", true);
    assert.equal(result, "Before [REDACTED] then [REDACTED] after");
  }
});

test("redaction buffering preserves complete Unicode characters at every chunk boundary", () => {
  const redactor = new SecretRedactor(["key"]);
  let output = "";
  for (const piece of ["🧪", "key", "🙂", " a"]) {
    const emitted = redactor.push(piece);
    assert.ok(!/[\uD800-\uDBFF]$/.test(emitted));
    output += emitted;
  }
  output += redactor.push("", true);
  assert.equal(output, "🧪[REDACTED]🙂 a");
});

test("checkpoint progress waits for a split credential while ordinary output is immediately durable", () => {
  const redactor = new SecretRedactor(["secret-credential-123"]);
  assert.equal(
    redactor.push("Local worker connected.\n\n"),
    "Local worker connected.\n\n",
  );
  assert.equal(redactor.canCheckpoint(), true);
  assert.equal(redactor.push("Before secret-cred"), "Before ");
  assert.equal(redactor.canCheckpoint(), false);
  assert.equal(redactor.push("ential-123 after"), "[REDACTED] after");
  assert.equal(redactor.canCheckpoint(), true);
  assert.equal(redactor.push(" sec"), " ");
  assert.equal(redactor.canCheckpoint(), false);
  assert.equal(redactor.push("", true), "sec");
  assert.equal(redactor.canCheckpoint(), true);
});
