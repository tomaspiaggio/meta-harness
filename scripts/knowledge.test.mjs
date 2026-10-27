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
import {
  decisionInstructions,
  filterDecisions,
} from "../packages/core/src/knowledge.ts";

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
    assert.match(
      instructions,
      /business\.pilot-price \(r2\): Business pilot price is \$219\./,
    );
    assert.match(instructions, /SHARED_DECISIONS\.md/);
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
test("turns get an index of decisions, this workspace first, within a budget", () => {
  const decision = (key, workspaceId, updatedAt, content) => ({
    key,
    content,
    revision: 1,
    sequence: updatedAt,
    workspaceId,
    sessionId: null,
    turnId: null,
    updatedAt,
  });
  const many = {
    revision: 200,
    decisions: [
      decision("tech.own", "tech", 1, "Own decision.\nSECRET-DETAIL"),
      decision("business.old", "business", 2, null),
      ...Array.from({ length: 150 }, (_, index) =>
        decision(`business.d${index}`, "business", 10 + index, "y".repeat(500)),
      ),
    ],
  };
  const instructions = decisionInstructions(many, "tech");
  const index = instructions.slice(instructions.indexOf("- "));
  assert.ok(index.startsWith("- tech.own (r1, this workspace): Own decision."));
  assert.doesNotMatch(instructions, /SECRET-DETAIL/);
  assert.match(instructions, /business\.d149 \(r1\): y+…/);
  assert.match(instructions, /…and \d+ more not listed here/);
  assert.ok(instructions.length < 12000);
  assert.deepEqual(
    filterDecisions(many, { query: "secret-detail OWN" }).decisions.map(
      (item) => item.key,
    ),
    ["tech.own"],
  );
  assert.deepEqual(
    filterDecisions(many, { keys: ["business.old", "nope"] }).decisions.map(
      (item) => item.key,
    ),
    ["business.old"],
  );
  assert.equal(filterDecisions(many, {}).decisions.length, 152);
  assert.match(
    decisionInstructions({ revision: 0, decisions: [] }),
    /no decisions yet/,
  );
});
