import assert from "node:assert/strict";
import { test } from "node:test";
import { goalProgress, parseGoalChange, plainText } from "./goals";

test("text for the owner rejects internal references and keeps plain words", () => {
  for (const text of [
    "Merged as 82898e25",
    "Fixed in #186",
    "Part of T-017",
    "See task-1c0da303a254",
    "Per litho.t017-ip-product-hw",
    "Now at r7",
    "Written to topics/fundraising/33-first-chip-cost-model.md",
  ])
    assert.throws(() => plainText(text, "Note", 300), /outside client/, text);
  for (const text of [
    "Only at 7nm or newer. Older processes need 2 to 3 chips.",
    "About $110 to $345 a month",
    "16 checks pass on the 10-layer board",
    "USB-C accelerator and the home box",
  ])
    assert.equal(plainText(text, "Note", 300), text);
});

test("a goal needs steps or targets, and a done step needs its answer", () => {
  const base = {
    title: "First circuit board",
    summary: "Design the first circuit board and get a quote",
    why: "Turns the board's cost into a number.",
    change: "Started from the chip's pin list",
  };
  assert.throws(() => parseGoalChange(base), /steps .* or targets/);
  assert.throws(
    () =>
      parseGoalChange({
        ...base,
        steps: [{ label: "Draw the circuit", status: "done" }],
      }),
    /give its answer/,
  );
  const change = parseGoalChange({
    ...base,
    steps: [
      { label: "Draw the circuit", status: "done", answer: "All drawn." },
      { label: "Check it", status: "review" },
      { label: "Chip-to-chip link", status: "postponed" },
      { label: "Get a quote", status: "todo" },
    ],
  });
  assert.deepEqual(goalProgress(change.goal), {
    done: 1,
    review: 1,
    working: 0,
    total: 3,
    fraction: 1 / 3,
  });
  // An update keeps the fields it leaves out.
  const update = parseGoalChange(
    { status: "done", change: "Quote received" },
    { ...change.goal, now: "Wiring", etaAt: 1 },
  );
  assert.equal(update.goal.title, "First circuit board");
  assert.equal(update.goal.now, "");
  assert.equal(update.goal.etaAt, null);
});

test("target goals measure progress against the numbers set", () => {
  const { goal } = parseGoalChange({
    title: "Expert meetings",
    summary: "Meet chip experts and possible customers",
    why: "Experts shape the plan.",
    change: "Week started",
    targets: [
      { label: "Connection requests", current: 15, target: 30 },
      { label: "Meetings booked", current: 3, target: 3 },
    ],
  });
  const progress = goalProgress(goal);
  assert.equal(progress.fraction, 0.75);
  assert.equal(progress.done, 1);
});
