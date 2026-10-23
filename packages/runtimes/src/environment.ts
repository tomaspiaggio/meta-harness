import type { Provider } from "@harness/core";
import { allowedSecretVariable } from "@harness/core/resources";

/** Provider authentication is separate from control-plane and application secrets. */
export function runtimeEnvironment(
  provider: Provider,
  inherited: NodeJS.ProcessEnv,
  granted: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const safe = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "TERM",
    "COLORTERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT",
    "WINDIR",
  ]);
  const authentication =
    provider === "claude"
      ? new Set([
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
        ])
      : provider === "codex"
        ? new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"])
        : new Set<string>();
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const [key, value] of Object.entries(inherited))
    if (
      value !== undefined &&
      (safe.has(key) || authentication.has(key) || /^LC_[A-Z_]+$/.test(key))
    )
      result[key] = value;
  for (const [key, value] of Object.entries(granted)) {
    if (!allowedSecretVariable(key) || safe.has(key))
      throw new Error("Invalid secret environment binding.");
    result[key] = value;
  }
  return result;
}
