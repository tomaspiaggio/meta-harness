import {
  type HarnessStore,
  openHarnessStore,
} from "@harness/storage/application";

const shared = globalThis as typeof globalThis & {
  harnessStore?: Promise<HarnessStore>;
};
export async function getStore(): Promise<HarnessStore> {
  shared.harnessStore ??= openHarnessStore().catch((error) => {
    shared.harnessStore = undefined;
    throw error;
  });
  return shared.harnessStore;
}
