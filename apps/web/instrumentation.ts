export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return;
  const { getWorld } = await import("workflow/runtime");
  const world = await getWorld();
  await world.start?.();
  const { hosted, hostedConfiguration } = await import("./server/hosted-auth");
  if (hosted()) {
    hostedConfiguration();
    return;
  }
  const { maintain } = await import("./server/maintenance");
  const shared = globalThis as typeof globalThis & {
    harnessDispatcher?: ReturnType<typeof setInterval>;
  };
  shared.harnessDispatcher ??= setInterval(() => {
    void maintain().catch((error) =>
      console.error("Dispatch will retry:", error),
    );
  }, 5000);
  shared.harnessDispatcher.unref();
}
