import { SqliteStore } from "@harness/storage";

const shared = globalThis as typeof globalThis & { harnessStore?: SqliteStore };
export function getStore(): SqliteStore {
  shared.harnessStore ??= new SqliteStore();
  return shared.harnessStore;
}
