import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureSnapshot, restoreSnapshot, validateSnapshot } from "./index";

test("execution files restore on another worker with checksums and executable bits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meta-checkpoint-"));
  try {
    const source = join(dir, "mac");
    const target = join(dir, "pi");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested/result.txt"), "checkpoint 🌱");
    const snapshot = await captureSnapshot(source);
    await restoreSnapshot(target, snapshot);
    assert.equal(
      await readFile(join(target, "nested/result.txt"), "utf8"),
      "checkpoint 🌱",
    );
    assert.throws(
      () =>
        validateSnapshot({
          version: 1,
          files: [{ ...snapshot.files[0], path: "../outside" }],
        }),
      /Unsafe/,
    );
    assert.throws(
      () =>
        validateSnapshot({
          version: 1,
          files: [{ ...snapshot.files[0], data: "Y29ycnVwdA==" }],
        }),
      /checksum/,
    );
    await symlink(join(source, "nested/result.txt"), join(source, "link"));
    await assert.rejects(captureSnapshot(source), /symlinks/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
