import { createObjectStore } from "@harness/storage/objects";

let objects: ReturnType<typeof createObjectStore> | undefined;
export function getObjects() {
  objects ??= createObjectStore();
  return objects;
}
