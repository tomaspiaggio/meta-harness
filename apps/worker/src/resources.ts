import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, platform } from "node:os";
import type { WorkerReport } from "@harness/core/scheduling";

type Memory = Pick<WorkerReport, "availableMemoryMiB" | "memoryPressure">;
const MiB = 1024 * 1024;
export function macMemory(
  stats: string,
  pressure: string,
  freeBytes: number,
): Memory {
  const level = Number(pressure.trim());
  const memoryPressure =
    level === 1
      ? "normal"
      : level === 2
        ? "warning"
        : level === 4
          ? "critical"
          : undefined;
  const pageSize = Number(stats.match(/page size of (\d+) bytes/)?.[1]);
  const free = Number(stats.match(/^Pages free:\s+(\d+)\./m)?.[1]);
  const inactive = Number(stats.match(/^Pages inactive:\s+(\d+)\./m)?.[1]);
  // Warning alone is advisory; estimate reclaimable inactive pages as well.
  // Keep critical/unknown pressure conservative. Do not add active,
  // compressed, purgeable, or speculative pages (which can overlap free pages).
  const availableBytes =
    (memoryPressure === "normal" || memoryPressure === "warning") &&
    pageSize > 0 &&
    Number.isFinite(free + inactive)
      ? (free + inactive) * pageSize
      : freeBytes;
  return {
    availableMemoryMiB: Math.floor(availableBytes / MiB),
    ...(memoryPressure ? { memoryPressure } : {}),
  };
}
export function linuxMemory(info: string, freeBytes: number): Memory {
  const availableKiB = Number(info.match(/^MemAvailable:\s+(\d+) kB/m)?.[1]);
  return {
    availableMemoryMiB: Math.floor(
      Number.isFinite(availableKiB) ? availableKiB / 1024 : freeBytes / MiB,
    ),
  };
}
let cached:
  | {
      at: number;
      memory: Memory;
    }
  | undefined;
/** Short OS probes, cached across polling lanes; no monitoring daemon. */
export function hostMemory(): Memory {
  if (cached && performance.now() - cached.at < 5000) return cached.memory;
  const freeBytes = freemem();
  let memory: Memory = { availableMemoryMiB: Math.floor(freeBytes / MiB) };
  try {
    if (platform() === "darwin") {
      const options = {
        encoding: "utf8" as const,
        timeout: 500,
        maxBuffer: 16384,
      };
      const pressure = execFileSync(
        "/usr/sbin/sysctl",
        ["-n", "kern.memorystatus_vm_pressure_level"],
        options,
      );
      const stats = execFileSync("/usr/bin/vm_stat", [], options);
      memory = macMemory(stats, pressure, freeBytes);
    } else if (platform() === "linux") {
      memory = linuxMemory(readFileSync("/proc/meminfo", "utf8"), freeBytes);
    }
  } catch {
    // Unknown hosts or failed probes retain the conservative free-memory check.
  }
  cached = { at: performance.now(), memory };
  return memory;
}
