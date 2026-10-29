import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentInstructions,
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
