import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentInstructions,
  machineSizes,
  parseHostFacts,
} from "../apps/web/server/agent-instructions.ts";

const session = {
  id: "s1",
  workspaceId: "tech",
  title: "Chip work",
  provider: "codex",
  titleSource: "manual",
};
const workspace = {
  id: "tech",
  name: "Tech",
  instructions: "Build the chip.",
  folder: "~/Projects/litho",
};
const host = {
  hostname: "jetdad",
  controlUrl: "https://control.example",
  folder: "/home/me/Projects/litho",
  fullAccess: true,
};
const build = (overrides = {}) =>
  agentInstructions({
    host,
    session,
    workspace,
    knowledge: { revision: 3, decisions: [] },
    unfinishedOperations: [],
    timezone: "America/Los_Angeles",
    now: new Date("2026-10-29T12:00:00Z"),
    ...overrides,
  });

test("control writes the turn's instructions from the worker's host facts", () => {
  const text = build();
  assert.match(text, /control server at https:\/\/control\.example/);
  assert.match(
    text,
    /runs as codex on worker host jetdad, in workspace "Tech"/,
  );
  assert.match(text, /full permissions/);
  assert.match(
    text,
    /Work in the workspace folder \/home\/me\/Projects\/litho/,
  );
  assert.match(text, /\nBuild the chip\.\n/);
  assert.match(text, /snapshot revision 3/);
  assert.match(text, /Current time: 2026-10-29T12:00:00\.000Z/);
  assert.match(text, /timezone is America\/Los_Angeles/);
  assert.match(text, /\(source: manual\)/);
  // A host without the folder says so, and a sandboxed session is told.
  const elsewhere = build({
    host: { ...host, folder: null },
    session: { ...session, sandboxed: 1 },
  });
  assert.match(
    elsewhere,
    /folder ~\/Projects\/litho does not exist on this machine \(jetdad\)/,
  );
  assert.match(elsewhere, /This session is sandboxed/);
});

test("host facts from a worker are validated", () => {
  assert.equal(parseHostFacts(undefined), null);
  assert.equal(parseHostFacts({ ...host, fullAccess: "yes" }), null);
  assert.equal(parseHostFacts({ ...host, folder: 3 }), null);
  assert.deepEqual(parseHostFacts({ ...host, folder: null }), {
    ...host,
    folder: null,
  });
});

test("agents on a small machine are told to move heavy builds to a larger one", () => {
  const now = 1_000_000;
  const machine = (id, memory, extra = {}) => ({
    id,
    name: id,
    draining: 0,
    seenAt: now,
    labels: [],
    report: {
      providers: ["codex"],
      labels: ["arm64"],
      totalMemoryMiB: memory,
      draining: false,
    },
    ...extra,
  });
  const workers = [
    machine("pi", 8192, { labels: ["pi"] }),
    machine("mac", 24576, { labels: ["mac"] }),
    machine("old", 65536, { seenAt: now - 60000 }),
    machine("paused", 65536, { draining: 1 }),
  ];
  const sizes = machineSizes("pi", workers, now);
  assert.deepEqual(sizes, {
    totalMemoryMiB: 8192,
    larger: { name: "mac", labels: ["mac"], totalMemoryMiB: 24576 },
  });
  const text = build({ machines: sizes });
  assert.match(text, /This machine has 8 GB of memory/);
  assert.match(text, /more than 2 GB of memory, move it to mac \(24 GB\)/);
  assert.match(text, /continue_on with labels \["mac"\]/);
  // The largest machine is told its size, not to move.
  const big = build({ machines: machineSizes("mac", workers, now) });
  assert.match(big, /This machine has 24 GB/);
  assert.doesNotMatch(big, /move it to/);
  // A worker that doesn't report its memory yet gets no sizing advice.
  const unknown = workers.map((worker) =>
    worker.id === "pi"
      ? { ...worker, report: { ...worker.report, totalMemoryMiB: undefined } }
      : worker,
  );
  assert.equal(machineSizes("pi", unknown, now), undefined);
});
