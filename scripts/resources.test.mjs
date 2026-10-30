import assert from "node:assert/strict";
import { test } from "node:test";
import {
  linuxMemory,
  macMemory,
  swapPressure,
} from "../apps/worker/src/resources.ts";

const stats = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 8192.
Pages inactive: 131072.
Pages speculative: 4096.
Pages active: 999999.
Pages purgeable: 32768.
Pages occupied by compressor: 999999.`;
test("normal-pressure Macs can admit a turn using inactive memory without double-counting other pools", () => {
  assert.deepEqual(macMemory(stats, "1\n", 128 * 1048576), {
    availableMemoryMiB: 2176,
    memoryPressure: "normal",
  });
});
test("warning pressure includes reclaimable memory; critical and unknown pressure remain conservative", () => {
  assert.deepEqual(macMemory(stats, "2", 128 * 1048576), {
    availableMemoryMiB: 2176,
    memoryPressure: "warning",
  });
  assert.equal(macMemory(stats, "4", 0).memoryPressure, "critical");
  assert.deepEqual(macMemory(stats, "unknown", 128 * 1048576), {
    availableMemoryMiB: 128,
  });
  assert.equal(
    macMemory("unparseable", "1", 128 * 1048576).availableMemoryMiB,
    128,
  );
});
test("Linux uses MemAvailable including reclaimable cache, with a free-memory fallback", () => {
  assert.equal(
    linuxMemory("MemFree: 131072 kB\nMemAvailable: 2228224 kB\n", 0)
      .availableMemoryMiB,
    2176,
  );
  assert.equal(
    linuxMemory("unparseable", 128 * 1048576).availableMemoryMiB,
    128,
  );
});

test("sustained swap-in sets Linux memory pressure", () => {
  const page = 16384;
  // 30 s at a given number of pages per second.
  const over = (perSecond) => [
    { at: 0, pages: 1000 },
    { at: 30000, pages: 1000 + perSecond * 30 },
  ];
  assert.equal(swapPressure(over(0), page), "normal");
  assert.equal(swapPressure(over(16), page), "normal");
  assert.equal(swapPressure(over(40), page), "warning");
  // 2.7 MB/s, the rate measured while a 4 GB compile stalled the Pi's browser.
  assert.equal(swapPressure(over(170), page), "critical");
  // Too short a window says nothing.
  assert.equal(
    swapPressure(
      [
        { at: 0, pages: 0 },
        { at: 5000, pages: 9999 },
      ],
      page,
    ),
    undefined,
  );
  assert.equal(swapPressure([], page), undefined);
});
