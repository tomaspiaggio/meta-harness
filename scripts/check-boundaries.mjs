import { readdir, readFile } from "node:fs/promises";

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      await Promise.all(
        entries
          .filter(
            (entry) =>
              !entry.name.startsWith(".") && entry.name !== "node_modules",
          )
          .map(async (entry) =>
            entry.isDirectory()
              ? await files(`${path}/${entry.name}`)
              : [`${path}/${entry.name}`],
          ),
      ),
    )
  ).flat();
}
const violations = [];
for (const path of [...(await files("packages")), ...(await files("apps"))]) {
  if (!/\.(ts|tsx)$/.test(path) || path.endsWith(".test.ts")) continue;
  const source = await readFile(path, "utf8");
  if (
    path.startsWith("packages/") &&
    /["'](?:use step|use workflow|workflow(?:\/[^"']*)?)["']/.test(source)
  ) {
    violations.push(`${path}: packages must not depend on Workflow.`);
  }
  if (
    path.startsWith("packages/core/") &&
    /from\s*["'](?:node:|@harness\/|workflow)/.test(source)
  ) {
    violations.push(`${path}: core must not import infrastructure.`);
  }
  if (
    path.startsWith("apps/web/") &&
    /from\s*["']@harness\/runtimes/.test(source)
  ) {
    violations.push(`${path}: agent runtimes belong in the worker.`);
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else console.log("Package boundaries passed.");
