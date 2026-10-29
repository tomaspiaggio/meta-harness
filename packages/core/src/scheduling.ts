import { HarnessError, type Provider } from "./index";
// A conversation agent waits on its model: about 100-350 MB and near-idle CPU
// (measured on the owner's Mac). Only builds and browsers reserve CPU.
export const profiles = {
  standard: { memoryMiB: 384, cpuSlots: 0 },
  build: { memoryMiB: 2048, cpuSlots: 2 },
  browser: { memoryMiB: 1024, cpuSlots: 1 },
} as const;
export type ResourceProfile = keyof typeof profiles;
export interface Task {
  id: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  objective: string;
  profile: ResourceProfile;
  priority: number;
  paused: number;
  targetWorkerId: string | null;
  createdAt: number;
}
export interface WorkerReport {
  agentIsolation?: boolean;
  browserHost?: boolean;
  browserStreaming?: boolean;
  browserBackend?: "managed" | "personal-chrome" | "extension";
  browserExtensionReady?: boolean;
  browserSlotsUsed?: number;
  browserMemoryMiB?: number;
  hostname: string;
  providers: Provider[];
  portableProviders?: Provider[];
  labels: string[];
  maxAgents: number;
  memoryBudgetMiB: number;
  cpuSlots: number;
  maxBuilds: number;
  maxBrowsers: number;
  availableMemoryMiB: number;
  memoryPressure?: "normal" | "warning" | "critical";
  reserveMemoryMiB: number;
  loadPerCpu: number;
  maxLoadPerCpu: number;
  draining: boolean;
  /** Short commit of the code this worker runs, when it can tell. */
  build?: string;
  /** Installed with the release launcher, so it can update itself. */
  updatable?: boolean;
  /** Progress of an update control asked for, or why it failed. */
  update?: { target: string; phase: UpdatePhase; message?: string };
}
export type UpdatePhase = "preparing" | "waiting" | "restarting" | "failed";
/** An update control asked a worker for, kept on the worker's row. */
export interface WorkerUpdate {
  target: string;
  status: "requested" | UpdatePhase | "done" | "cancelled";
  requestedAt: number;
  requestedBy: string;
  from?: string;
  message?: string;
  finishedAt?: number;
}
export const updateActive = (update?: WorkerUpdate | null) =>
  !!update &&
  ["requested", "preparing", "waiting", "restarting"].includes(update.status);
/** Two commit prefixes name the same commit (at least 7 hex digits each). */
export function sameCommit(a?: string, b?: string): boolean {
  if (!a || !b || a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}
export const COMMIT = /^[0-9a-f]{7,40}$/;
export interface WorkerRecord {
  id: string;
  name: string;
  report: WorkerReport | null;
  seenAt: number | null;
  draining: number;
  /** Labels the owner gave this machine, such as "asap7" or "mac". */
  labels?: string[];
  update?: WorkerUpdate | null;
}
const LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** Owner labels: lowercase words, digits, dots, dashes and underscores. */
export function parseLabels(value: unknown): string[] {
  const items =
    typeof value === "string"
      ? value.split(/[\s,]+/)
      : Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : null;
  if (!items || items.some((item) => typeof item !== "string"))
    throw new HarnessError("Labels must be a list of words.");
  const labels = [
    ...new Set(
      (items as string[])
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const invalid = labels.find((label) => !LABEL.test(label));
  if (invalid)
    throw new HarnessError(
      `"${invalid}" is not a valid label. Use up to 40 lowercase letters, digits, dots, dashes or underscores.`,
    );
  if (labels.length > 16) throw new HarnessError("Use at most 16 labels.");
  return labels;
}
/** Stored as a comma-separated list; labels never contain commas. */
export function labelList(stored: string | null | undefined): string[] {
  return stored ? stored.split(",").filter(Boolean) : [];
}
/**
 * Everything a machine offers, like Kubernetes node labels: the agents it
 * runs, "browser" when it has one, labels set in its environment, and labels
 * the owner added.
 */
export function workerLabels(worker: WorkerRecord): string[] {
  const report = worker.report;
  return [
    ...new Set([
      ...(report?.providers ?? []).filter((provider) => provider !== "demo"),
      ...(report?.browserHost ? ["browser"] : []),
      ...(report?.labels ?? []).map((label) => label.toLowerCase()),
      ...(worker.labels ?? []),
    ]),
  ];
}
/** Labels a session requires that this machine lacks. */
export function missingLabels(
  required: string[],
  worker: WorkerRecord,
): string[] {
  const offered = workerLabels(worker);
  return required.filter((label) => !offered.includes(label));
}
export interface Allocation {
  profile: ResourceProfile;
  provider: Provider;
}
export function requirements(profile: ResourceProfile, provider: Provider) {
  // Demo models orchestration without reserving a real agent's full footprint.
  return provider === "demo" && profile === "standard"
    ? { memoryMiB: 64, cpuSlots: 1 }
    : profiles[profile];
}
/** Admission policy only: it never changes or kills processes on the host. */
export function admissionReason(
  report: WorkerReport,
  allocations: Allocation[],
  profile: ResourceProfile,
  provider: Provider,
  /** Work between sessions; the owner's messages and planners are not. */
  background = false,
): string | null {
  if (report.draining) return "Worker is draining";
  if (!report.providers.includes(provider))
    return `${provider} is not available here`;
  if (allocations.length >= report.maxAgents)
    return "All agent slots are occupied";
  // The last slot is kept so the owner's messages never wait behind workers.
  if (
    background &&
    report.maxAgents > 1 &&
    allocations.length >= report.maxAgents - 1
  )
    return "All background slots are occupied (one is kept for your messages)";
  if (provider !== "demo" && report.memoryPressure === "critical")
    return "Host memory pressure is critical; waiting for it to ease";
  // Agent turns mostly wait on a remote model; only builds add real CPU work.
  // A host busy with other work (a laptop) still takes conversation turns.
  if (profile === "build" && report.loadPerCpu > report.maxLoadPerCpu)
    return "Host CPU load is above the configured threshold";
  const needs = requirements(profile, provider);
  const used = allocations.reduce(
    (sum, item) => {
      const allocation = requirements(item.profile, item.provider);
      return {
        memoryMiB: sum.memoryMiB + allocation.memoryMiB,
        cpuSlots: sum.cpuSlots + allocation.cpuSlots,
      };
    },
    { memoryMiB: 0, cpuSlots: 0 },
  );
  if (
    used.memoryMiB + needs.memoryMiB + (report.browserMemoryMiB ?? 0) >
    report.memoryBudgetMiB
  )
    return "Harness memory reservations are full";
  if (needs.memoryMiB > report.availableMemoryMiB - report.reserveMemoryMiB)
    return `Preserving host memory headroom: ${report.availableMemoryMiB} MiB available; ${needs.memoryMiB + report.reserveMemoryMiB} MiB needed (${needs.memoryMiB} MiB for this turn + ${report.reserveMemoryMiB} MiB reserve)`;
  if (used.cpuSlots + needs.cpuSlots > report.cpuSlots)
    return `All ${report.cpuSlots} CPU slots are in use`;
  if (
    profile === "build" &&
    allocations.filter((item) => item.profile === "build").length >=
      report.maxBuilds
  )
    return "All build slots are occupied";
  if (
    profile === "browser" &&
    allocations.filter((item) => item.profile === "browser").length >=
      report.maxBrowsers
  )
    return "All browser slots are occupied";
  return null;
}
export function parseProfile(value: unknown): ResourceProfile {
  if (value === undefined || value === "standard") return "standard";
  if (value === "build" || value === "browser") return value;
  throw new HarnessError("Choose standard, build, or browser.");
}
export function parseWorkerReport(value: unknown): WorkerReport {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("Invalid worker report.");
  const row = value as Record<string, unknown>;
  const count = (key: string, minimum = 0, maximum = 16777216): number => {
    const value = row[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    )
      throw new HarnessError(`Invalid worker ${key}.`);
    return value;
  };
  if (
    typeof row.hostname !== "string" ||
    !row.hostname ||
    row.hostname.length > 200 ||
    typeof row.draining !== "boolean"
  )
    throw new HarnessError("Invalid worker identity.");
  if (
    !Array.isArray(row.providers) ||
    row.providers.length > 3 ||
    row.providers.some(
      (provider) =>
        provider !== "demo" && provider !== "claude" && provider !== "codex",
    )
  )
    throw new HarnessError("Invalid worker providers.");
  if (
    !Array.isArray(row.labels) ||
    row.labels.length > 32 ||
    row.labels.some((label) => typeof label !== "string" || label.length > 64)
  )
    throw new HarnessError("Invalid worker labels.");
  for (const key of ["loadPerCpu", "maxLoadPerCpu"])
    if (
      typeof row[key] !== "number" ||
      !Number.isFinite(row[key]) ||
      row[key] < 0 ||
      row[key] > 10000
    )
      throw new HarnessError(`Invalid worker ${key}.`);
  if (
    row.memoryPressure !== undefined &&
    row.memoryPressure !== "normal" &&
    row.memoryPressure !== "warning" &&
    row.memoryPressure !== "critical"
  )
    throw new HarnessError("Invalid worker memoryPressure.");
  return {
    ...(row.agentIsolation === undefined
      ? {}
      : { agentIsolation: row.agentIsolation === true }),
    ...(row.browserStreaming === undefined
      ? {}
      : { browserStreaming: row.browserStreaming === true }),
    ...(row.browserHost === undefined
      ? {}
      : { browserHost: row.browserHost === true }),
    ...(row.browserBackend === "managed" ||
    row.browserBackend === "personal-chrome" ||
    row.browserBackend === "extension"
      ? { browserBackend: row.browserBackend }
      : {}),
    ...(row.browserExtensionReady === undefined
      ? {}
      : { browserExtensionReady: row.browserExtensionReady === true }),
    ...(row.browserSlotsUsed === undefined
      ? {}
      : { browserSlotsUsed: count("browserSlotsUsed", 0, 64) }),
    ...(row.browserMemoryMiB === undefined
      ? {}
      : { browserMemoryMiB: count("browserMemoryMiB") }),
    hostname: row.hostname,
    providers: [...new Set(row.providers)] as Provider[],
    ...(Array.isArray(row.portableProviders)
      ? {
          portableProviders: row.portableProviders.filter(
            (provider): provider is Provider =>
              provider === "demo" ||
              provider === "claude" ||
              provider === "codex",
          ),
        }
      : {}),
    labels: row.labels as string[],
    maxAgents: count("maxAgents", 1, 100),
    memoryBudgetMiB: count("memoryBudgetMiB", 1),
    cpuSlots: count("cpuSlots", 1, 1024),
    maxBuilds: count("maxBuilds", 0, 100),
    maxBrowsers: count("maxBrowsers", 0, 100),
    availableMemoryMiB: count("availableMemoryMiB"),
    ...(row.memoryPressure === undefined
      ? {}
      : {
          memoryPressure: row.memoryPressure as WorkerReport["memoryPressure"],
        }),
    reserveMemoryMiB: count("reserveMemoryMiB"),
    loadPerCpu: row.loadPerCpu as number,
    maxLoadPerCpu: row.maxLoadPerCpu as number,
    draining: row.draining,
    ...(typeof row.build === "string" && COMMIT.test(row.build)
      ? { build: row.build }
      : {}),
    ...(row.updatable === true ? { updatable: true } : {}),
    ...(parseUpdate(row.update) ?? {}),
  };
}
function parseUpdate(value: unknown): Pick<WorkerReport, "update"> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.target !== "string" ||
    !COMMIT.test(row.target) ||
    !["preparing", "waiting", "restarting", "failed"].includes(
      row.phase as string,
    )
  )
    return null;
  return {
    update: {
      target: row.target,
      phase: row.phase as UpdatePhase,
      ...(typeof row.message === "string"
        ? { message: row.message.slice(0, 1000) }
        : {}),
    },
  };
}
