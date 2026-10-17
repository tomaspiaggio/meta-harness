import { ControlStore } from "@harness/storage/control";

const shared = globalThis as typeof globalThis & {
  harnessStore?: ControlStore;
};
export function getStore(): ControlStore {
  shared.harnessStore ??= new ControlStore();
  return shared.harnessStore;
}
