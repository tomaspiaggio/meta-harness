import { HarnessError, type Provider } from "./index";
export const profiles = {
  standard: { memoryMiB: 512, cpuSlots: 1 },
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
}
export interface WorkerRecord {
  id: string;
  name: string;
  report: WorkerReport | null;
  seenAt: number | null;
  draining: number;
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
): string | null {
  if (report.draining) return "Worker is draining";
  if (!report.providers.includes(provider))
    return `${provider} is unavailable on this worker`;
  if (allocations.length >= report.maxAgents)
    return "All agent slots are occupied";
  if (provider !== "demo" && report.memoryPressure === "critical")
    return "Host memory pressure is critical; waiting for it to ease";
  if (provider !== "demo" && report.loadPerCpu > report.maxLoadPerCpu)
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
    return "Harness CPU reservations are full";
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
  };
}
