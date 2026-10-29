import assert from "node:assert/strict";
import { test } from "node:test";
import { retarget, sameCommit } from "./update-control.mjs";

test("a server update points only the current release's paths at the new one", () => {
  const unit = [
    "WorkingDirectory=/home/me/releases/7613a84",
    "ExecStart=/usr/bin/node /home/me/releases/7613a84/scripts/dev.mjs",
    "Environment=OTHER=/home/me/releases/7613a84x",
    "Environment=KEEP=/home/me/releases/7613a8",
  ].join("\n");
  assert.equal(
    retarget(unit, "/home/me/releases/7613a84", "/home/me/releases/9f16d02"),
    [
      "WorkingDirectory=/home/me/releases/9f16d02",
      "ExecStart=/usr/bin/node /home/me/releases/9f16d02/scripts/dev.mjs",
      "Environment=OTHER=/home/me/releases/7613a84x",
      "Environment=KEEP=/home/me/releases/7613a8",
    ].join("\n"),
  );
  assert.ok(sameCommit("9f16d02", "9f16d02aa"));
  assert.ok(!sameCommit("9f16d02", "9f16d03"));
  assert.ok(!sameCommit(undefined, "9f16d02"));
});
