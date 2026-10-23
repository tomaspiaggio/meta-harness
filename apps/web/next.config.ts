import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const config: NextConfig = {
  transpilePackages: ["@harness/core", "@harness/storage"],
  serverExternalPackages: ["node:sqlite"],
  outputFileTracingExcludes: {
    "/*": ["../../.data/**/*", "../../.env*", "../../.git/**/*"],
  },
  experimental: { cpus: 1 },
  poweredByHeader: false,
};
export default withWorkflow(config);
