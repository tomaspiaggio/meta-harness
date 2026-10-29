import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  afterExit,
  confirmRelease,
  installRoot,
  prepareRelease,
  RESTART,
  readState,
  switchRelease,
} from "./worker-launcher.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** A remote with two commits on main and one on a side branch. */
function remote(directory) {
  const origin = join(directory, "origin");
  mkdirSync(join(origin, "scripts"), { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test");
  writeFileSync(
    join(origin, "scripts", "worker-launcher.mjs"),
    "// launcher v1\n",
  );
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "one");
  const first = git(origin, "rev-parse", "HEAD");
  writeFileSync(
    join(origin, "scripts", "worker-launcher.mjs"),
    "// launcher v2\n",
  );
  git(origin, "commit", "-q", "-am", "two");
  const second = git(origin, "rev-parse", "HEAD");
  git(origin, "switch", "-q", "-c", "side");
  writeFileSync(join(origin, "side.txt"), "unmerged\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "side");
  const side = git(origin, "rev-parse", "HEAD");
  git(origin, "switch", "-q", "main");
  return { origin, first, second, side };
}
const install = ["node", "-e", "require('fs').writeFileSync('installed','1')"];

test("installs, updates to merged commits only, confirms and prunes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "launcher-"));
  try {
    const { origin, first, second, side } = remote(directory);
    const root = join(directory, "root");
    const one = await installRoot(root, first.slice(0, 7), { origin, install });
    assert.equal(one, first.slice(0, 12));
    assert.deepEqual(readState(root), { current: one });
    assert.equal(
      readFileSync(join(root, "launcher.mjs"), "utf8"),
      "// launcher v1\n",
    );
    assert.ok(existsSync(join(root, "releases", one, "installed")));
    await assert.rejects(
      prepareRelease(root, side.slice(0, 7), { install }),
      /not on origin\/main/,
    );
    await assert.rejects(
      prepareRelease(root, "1234567", { install }),
      /not found/,
    );
    // A failed install leaves no half-made release behind.
    await assert.rejects(
      prepareRelease(root, second.slice(0, 7), { install: ["false"] }),
      /Installing/,
    );
    assert.ok(!existsSync(join(root, "releases", second.slice(0, 12))));
    const two = await prepareRelease(root, second.slice(0, 7), { install });
    assert.equal(await prepareRelease(root, second, { install }), two);
    switchRelease(root, two, 1000);
    assert.deepEqual(readState(root), {
      current: two,
      previous: one,
      pending: { target: two, from: one, failures: 0, at: 1000 },
    });
    assert.equal(confirmRelease(root, "other"), false);
    assert.equal(confirmRelease(root, two), true);
    assert.deepEqual(readState(root), { current: two, previous: one });
    assert.equal(
      readFileSync(join(root, "launcher.mjs"), "utf8"),
      "// launcher v2\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new release that fails twice or never confirms is rolled back", () => {
  const pending = {
    current: "new",
    previous: "old",
    pending: { target: "new", from: "old", failures: 0, at: 1 },
  };
  // Restarts the worker asked for, and confirmed releases, change nothing.
  assert.equal(afterExit(pending, { code: RESTART }), pending);
  const steady = { current: "new", previous: "old" };
  assert.equal(afterExit(steady, { code: 1 }), steady);
  const once = afterExit(pending, { code: 1 });
  assert.equal(once.current, "new");
  assert.equal(once.pending.failures, 1);
  const back = afterExit(once, { code: 1, now: 5 });
  assert.deepEqual(back, {
    current: "old",
    lastFailure: {
      target: "new",
      at: 5,
      reason: "the new release exited with code 1 twice",
    },
  });
  const silent = afterExit(pending, { code: 143, timedOut: true, now: 7 });
  assert.equal(silent.current, "old");
  assert.match(silent.lastFailure.reason, /did not reach control/);
});
