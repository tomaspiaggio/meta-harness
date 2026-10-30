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
type SwapSample = { at: number; pages: number };
/**
 * Linux reports no pressure level, and kernels without PSI (the Raspberry Pi's)
 * give no other signal: MemAvailable stays healthy while a large build pushes
 * everything else into swap. Sustained swap-in is the symptom that stalls the
 * browser and the server, so it sets the level.
 */
export function swapPressure(
  samples: SwapSample[],
  pageBytes: number,
): WorkerReport["memoryPressure"] {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.at - first.at < 20000) return undefined;
  const bytesPerSecond =
    ((last.pages - first.pages) * pageBytes * 1000) / (last.at - first.at);
  return bytesPerSecond >= 2 * MiB
    ? "critical"
    : bytesPerSecond >= MiB / 2
      ? "warning"
      : "normal";
}
const swapSamples: SwapSample[] = [];
let pageBytes: number | undefined;
function linuxSwapPressure(): WorkerReport["memoryPressure"] {
  const pages = Number(
    readFileSync("/proc/vmstat", "utf8").match(/^pswpin (\d+)$/m)?.[1],
  );
  if (!Number.isFinite(pages)) return undefined;
  pageBytes ??=
    Number(
      execFileSync("getconf", ["PAGESIZE"], {
        encoding: "utf8",
        timeout: 500,
      }).trim(),
    ) || 4096;
  const at = performance.now();
  swapSamples.push({ at, pages });
  while (swapSamples.length > 2 && at - (swapSamples[1]?.at ?? at) >= 30000)
    swapSamples.shift();
  return swapPressure(swapSamples, pageBytes);
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
      const memoryPressure = linuxSwapPressure();
      if (memoryPressure) memory = { ...memory, memoryPressure };
    }
  } catch {
    // Unknown hosts or failed probes retain the conservative free-memory check.
  }
  cached = { at: performance.now(), memory };
  return memory;
}
