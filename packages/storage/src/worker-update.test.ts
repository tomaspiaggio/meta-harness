import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkerReport, type WorkerReport } from "@harness/core/scheduling";
import { HarnessStore } from "./application";

const report: WorkerReport = {
  hostname: "bench",
  providers: ["demo", "codex"],
  labels: ["arm64"],
  maxAgents: 2,
  memoryBudgetMiB: 4096,
  cpuSlots: 4,
  maxBuilds: 1,
  maxBrowsers: 1,
  availableMemoryMiB: 8192,
  reserveMemoryMiB: 1024,
  loadPerCpu: 0.1,
  maxLoadPerCpu: 1,
  draining: false,
  build: "aaaaaaa",
  updatable: true,
};
async function setup() {
  const store = new HarnessStore(":memory:");
  await store.ready;
  const mac = await store.createWorker("mac");
  const pi = await store.createWorker("pi");
  return { store, mac, pi };
}

test("a machine updates only while another one can run agents", async () => {
  const { store, mac, pi } = await setup();
  try {
    await store.reportWorker(mac.id, report);
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "bbbbbbb", "owner"),
      /would leave no online machine/,
    );
    // A machine with only the demo agent doesn't count as able to run agents.
    await store.reportWorker(pi.id, { ...report, providers: ["demo"] });
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "bbbbbbb", "owner"),
      /would leave no online machine/,
    );
    await store.reportWorker(pi.id, report);
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "aaaaaaa1", "owner"),
      /already runs/,
    );
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "main", "owner"),
      /7 to 40/,
    );
    const update = await store.requestWorkerUpdate(mac.id, "bbbbbbb", "owner");
    assert.equal(update.status, "requested");
    assert.equal(update.from, "aaaaaaa");
    // One machine at a time, so the other stays up.
    await assert.rejects(
      store.requestWorkerUpdate(pi.id, "bbbbbbb", "owner"),
      /already updating/,
    );
    // While the Mac is paused for the update, it doesn't count for the Pi.
    assert.equal(
      await store.reportWorker(mac.id, {
        ...report,
        draining: true,
        update: { target: "bbbbbbb", phase: "waiting" },
      }),
      "bbbbbbb",
    );
    assert.equal(
      (await store.listWorkers()).find((item) => item.id === mac.id)?.update
        ?.status,
      "waiting",
    );
    // The new release reports in: done, and the reply asks for nothing.
    assert.equal(
      await store.reportWorker(mac.id, { ...report, build: "bbbbbbb" }),
      null,
    );
    const done = (await store.listWorkers()).find(
      (item) => item.id === mac.id,
    )?.update;
    assert.equal(done?.status, "done");
    assert.ok(done?.finishedAt);
    // Now the Pi may update, since the Mac is back.
    await store.requestWorkerUpdate(pi.id, "bbbbbbb", "owner");
  } finally {
    await store.close();
  }
});

test("failed and cancelled updates end, and offline or old workers are refused", async () => {
  const { store, mac, pi } = await setup();
  try {
    await store.reportWorker(pi.id, report);
    await store.reportWorker(mac.id, { ...report, updatable: undefined });
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "bbbbbbb", "owner"),
      /release launcher/,
    );
    await store.reportWorker(mac.id, report, Date.now() - 60000);
    await assert.rejects(
      store.requestWorkerUpdate(mac.id, "bbbbbbb", "owner"),
      /not online/,
    );
    await store.reportWorker(mac.id, report);
    await store.requestWorkerUpdate(mac.id, "bbbbbbb", "agent: Deploy");
    // A rolled-back release reports the failure; the reply clears the request.
    assert.equal(
      await store.reportWorker(mac.id, {
        ...report,
        update: {
          target: "bbbbbbbcccc",
          phase: "failed",
          message: "Rolled back to aaaaaaa: exited twice.",
        },
      }),
      null,
    );
    const failed = (await store.listWorkers()).find(
      (item) => item.id === mac.id,
    )?.update;
    assert.equal(failed?.status, "failed");
    assert.match(failed?.message ?? "", /Rolled back/);
    await assert.rejects(store.cancelWorkerUpdate(mac.id), /No update/);
    await store.requestWorkerUpdate(mac.id, "ccccccc", "owner");
    await store.cancelWorkerUpdate(mac.id);
    assert.equal(await store.reportWorker(mac.id, report), null);
    await store.requestWorkerUpdate(mac.id, "ccccccc", "owner");
    await store.reportWorker(mac.id, {
      ...report,
      update: { target: "ccccccc", phase: "restarting" },
    });
    await assert.rejects(store.cancelWorkerUpdate(mac.id), /restarting/);
  } finally {
    await store.close();
  }
});

test("reports keep only valid build and update fields", () => {
  const parsed = parseWorkerReport({
    ...report,
    build: "not-a-commit",
    update: { target: "bbbbbbb", phase: "exploded" },
  });
  assert.equal(parsed.build, undefined);
  assert.equal(parsed.update, undefined);
  assert.deepEqual(
    parseWorkerReport({
      ...report,
      update: { target: "bbbbbbb", phase: "failed", message: "x" },
    }).update,
    { target: "bbbbbbb", phase: "failed", message: "x" },
  );
});
