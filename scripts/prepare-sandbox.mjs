import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const value = (flag) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const source = value("--source");
const revision = value("--revision");
if (!source || !revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error(
    "Use pnpm sandbox:prepare --source https://public-git-repository --revision <40-character commit>. This explicitly creates billable cloud build capacity.",
  );
const url = new URL(source);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error(
    "Use a public HTTPS repository without embedded credentials.",
  );
const require = createRequire(import.meta.url);
const { Sandbox } = await import(
  pathToFileURL(
    require.resolve("@vercel/sandbox", { paths: [resolve("apps/web")] }),
  ).href
);
const credentials =
  process.env.VERCEL_TOKEN &&
  process.env.VERCEL_TEAM_ID &&
  process.env.VERCEL_PROJECT_ID
    ? {
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      }
    : {};
const sandbox = await Sandbox.create({
  runtime: "node24",
  timeout: 600000,
  resources: { vcpus: 1 },
  ...credentials,
});
try {
  async function run(cmd, args, options = {}) {
    const result = await sandbox.runCommand({ cmd, args, ...options });
    if (result.exitCode !== 0)
      throw new Error(
        `Preparation command ${cmd} failed (${result.exitCode}); inspect this build before publishing its snapshot.`,
      );
  }
  await run(
    "npm",
    ["install", "--global", "pnpm@10.10.0", "@openai/codex@0.163.0"],
    { sudo: true },
  );
  await run("git", [
    "clone",
    "--no-checkout",
    source,
    "/vercel/sandbox/meta-harness",
  ]);
  const cwd = "/vercel/sandbox/meta-harness";
  await run("git", ["checkout", "--detach", revision], { cwd });
  await run("pnpm", ["install", "--frozen-lockfile"], { cwd });
  await run(
    "node",
    [
      "--import",
      "tsx",
      "-e",
      "import('./src/isolation.ts').then(m=>console.log(typeof m.prepareIdentity))",
    ],
    { cwd: `${cwd}/apps/worker` },
  );
  await run("codex", ["--version"]);
  await run("chmod", ["a+rx", "/vercel/sandbox", cwd]);
  const snapshot = await sandbox.snapshot();
  console.log(`HARNESS_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}`);
  console.log(`HARNESS_SANDBOX_WORKER_PATH=${cwd}/apps/worker`);
  console.log(
    `Prepared revision ${revision}. Validate a Demo job before enabling provider credentials.`,
  );
} finally {
  await sandbox.stop();
}
