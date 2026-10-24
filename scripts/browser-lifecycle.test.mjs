import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorker } from "../apps/worker/src/browser.ts";

test("the browser poller retains a fresh stream allocation while the out-of-band launch starts", async () => {
  for (const scenario of [
    { status: "starting", age: 100, opening: false, release: false },
    { status: "starting", age: 20000, opening: false, release: true },
    { status: "starting", age: 20000, opening: true, release: false },
    { status: "ready", age: 20000, opening: false, release: true },
  ]) {
    const controller = new AbortController();
    const calls = [];
    let closed = false;
    const client = {
      async post(action) {
        calls.push(action);
        controller.abort();
        return {
          assignments: [],
          identities: [
            {
              id: "browser",
              mode: "agent",
              status: scenario.status,
              updatedAt: Date.now() - scenario.age,
              generation: 1,
            },
          ],
        };
      },
    };
    const host = {
      active: () =>
        scenario.opening ? [{ id: "browser", generation: 1 }] : [],
      synchronize: async () => {},
      close: async () => {
        closed = true;
      },
    };
    await browserWorker(client, "fixture", controller.signal, host);
    assert.equal(
      calls.includes("browser-release"),
      scenario.release,
      JSON.stringify(scenario),
    );
    assert(closed);
  }
});
