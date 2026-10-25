import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admissionReason,
  parseWorkerReport,
  type WorkerReport,
} from "./scheduling";

const report: WorkerReport = {
  hostname: "test-host",
  providers: ["demo", "claude"],
  labels: ["test"],
  maxAgents: 3,
  memoryBudgetMiB: 4096,
  cpuSlots: 4,
  maxBuilds: 1,
  maxBrowsers: 1,
  availableMemoryMiB: 8192,
  reserveMemoryMiB: 1024,
  loadPerCpu: 0.2,
  maxLoadPerCpu: 1,
  draining: false,
};
test("admission preserves host headroom independently of the harness budget", () => {
  assert.equal(admissionReason(report, [], "standard", "claude"), null);
  assert.match(
    admissionReason(
      { ...report, availableMemoryMiB: 1200 },
      [],
      "standard",
      "claude",
    ) ?? "",
    /headroom/,
  );
  assert.match(
    admissionReason(
      { ...report, memoryBudgetMiB: 256 },
      [],
      "standard",
      "claude",
    ) ?? "",
    /reservations/,
  );
  assert.match(
    admissionReason({ ...report, loadPerCpu: 1.5 }, [], "build", "claude") ??
      "",
    /CPU load/,
  );
});
test("build, browser, and agent slot limits are independent", () => {
  assert.match(
    admissionReason(
      report,
      [{ profile: "build", provider: "claude" }],
      "build",
      "claude",
    ) ?? "",
    /build slots/,
  );
  assert.match(
    admissionReason(
      report,
      [{ profile: "browser", provider: "claude" }],
      "browser",
      "claude",
    ) ?? "",
    /browser slots/,
  );
  assert.match(
    admissionReason(
      { ...report, maxAgents: 1 },
      [{ profile: "standard", provider: "demo" }],
      "standard",
      "demo",
    ) ?? "",
    /agent slots/,
  );
  assert.equal(
    admissionReason(
      report,
      [{ profile: "build", provider: "claude" }],
      "standard",
      "claude",
    ),
    null,
  );
});
test("draining and unsupported providers wait without consuming capacity", () => {
  assert.match(
    admissionReason({ ...report, draining: true }, [], "standard", "demo") ??
      "",
    /draining/,
  );
  assert.match(
    admissionReason(report, [], "standard", "codex") ?? "",
    /unavailable/,
  );
});
test("worker reports reject invalid measurements and unbounded concurrency", async () => {
  assert.deepEqual(parseWorkerReport(report), report);
  await assert.rejects(
    async () =>
      parseWorkerReport({ ...report, availableMemoryMiB: Number.NaN }),
    /availableMemory/,
  );
  await assert.rejects(
    async () => parseWorkerReport({ ...report, maxAgents: 1000000 }),
    /maxAgents/,
  );
  await assert.rejects(
    async () => parseWorkerReport({ ...report, providers: ["unknown"] }),
    /providers/,
  );
});
test("macOS warning is advisory; critical pressure blocks new agents", async () => {
  assert.equal(
    admissionReason(
      { ...report, memoryPressure: "warning" },
      [],
      "standard",
      "claude",
    ),
    null,
  );
  assert.match(
    admissionReason(
      { ...report, memoryPressure: "critical" },
      [],
      "standard",
      "claude",
    ) ?? "",
    /memory pressure is critical/,
  );
  await assert.rejects(
    async () => parseWorkerReport({ ...report, memoryPressure: "invalid" }),
    /memoryPressure/,
  );
  // Demo runs inside the resident worker and starts no agent subprocess.
  assert.equal(
    admissionReason(
      { ...report, memoryPressure: "warning" },
      [],
      "standard",
      "demo",
    ),
    null,
  );
});
test("host CPU load only holds back builds, not conversation turns", () => {
  const busyHost = { ...report, loadPerCpu: 4 };
  assert.equal(admissionReason(busyHost, [], "standard", "demo"), null);
  assert.equal(admissionReason(busyHost, [], "standard", "claude"), null);
  assert.equal(admissionReason(busyHost, [], "browser", "claude"), null);
  assert.match(
    admissionReason(busyHost, [], "build", "claude") ?? "",
    /CPU load/,
  );
});
