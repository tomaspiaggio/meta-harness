import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// Inlined into both the server and the browser bundle, so an open app can tell
// that a newer version was deployed and reload itself.
const build = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "development";
  }
})();

const config: NextConfig = {
  transpilePackages: ["@harness/core", "@harness/storage"],
  serverExternalPackages: ["node:sqlite"],
  outputFileTracingExcludes: {
    "/*": ["../../.data/**/*", "../../.env*", "../../.git/**/*"],
  },
  experimental: { cpus: 1 },
  poweredByHeader: false,
  env: { HARNESS_BUILD: build },
};
export default withWorkflow(config);
