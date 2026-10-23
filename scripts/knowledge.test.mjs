import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearDecisionUpdates,
  collectDecisionUpdates,
  prepareDecisionFiles,
} from "../apps/worker/src/knowledge.ts";
import { decisionInstructions } from "../packages/core/src/knowledge.ts";

const snapshot = {
  revision: 2,
  decisions: [
    {
      key: "business.pilot-price",
      content: "Business pilot price is $219.",
      revision: 2,
      sequence: 2,
      workspaceId: "tech",
      sessionId: null,
      turnId: null,
      updatedAt: 0,
    },
  ],
};
test("turn preparation proactively supplies the fresh decision and preserves unpublished edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-knowledge-"));
  try {
    await writeFile(
      join(directory, "DECISIONS.md"),
      "Old session note: pilot price is $173.",
    );
    await writeFile(
      join(directory, "DECISION_UPDATES.json"),
      '[{"key":"draft","content":"Unpublished","expectedRevision":0}]',
    );
    await prepareDecisionFiles(directory, snapshot);
    assert.match(
      await readFile(join(directory, "SHARED_DECISIONS.md"), "utf8"),
      /219/,
    );
    assert.match(
      await readFile(join(directory, "DECISIONS.md"), "utf8"),
      /173/,
    );
    assert.ok(
      (await readdir(directory)).some((name) =>
        name.startsWith("DECISION_UPDATES.unpublished."),
      ),
    );
    assert.deepEqual(await collectDecisionUpdates(directory), []);
    const instructions = decisionInstructions(snapshot);
    assert.match(instructions, /219/);
    assert.match(instructions, /proactively/);
    assert.match(instructions, /supersede older versions/);
    await writeFile(
      join(directory, "DECISION_UPDATES.json"),
      '[{"key":"business.pilot-price","content":"$249","expectedRevision":2}]',
    );
    assert.equal(
      (await collectDecisionUpdates(directory))[0].expectedRevision,
      2,
    );
    await clearDecisionUpdates(directory);
    assert.deepEqual(await collectDecisionUpdates(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("invalid or symlinked publication files cannot report successful publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meta-knowledge-"));
  try {
    await writeFile(join(directory, "DECISION_UPDATES.json"), "not JSON");
    await assert.rejects(collectDecisionUpdates(directory), /not published/);
    await rm(join(directory, "DECISION_UPDATES.json"));
    await writeFile(join(directory, "private"), "[]");
    await symlink(
      join(directory, "private"),
      join(directory, "DECISION_UPDATES.json"),
    );
    await assert.rejects(collectDecisionUpdates(directory), /not published/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
