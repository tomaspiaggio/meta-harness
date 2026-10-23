import { HarnessError } from "./index";
export function allowedSecretVariable(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(name)) return false;
  if (name === "CLAUDE_CODE_OAUTH_TOKEN") return true;
  return !/^(?:HARNESS_|WORKFLOW_|NODE_|LD_|DYLD_|GIT_|CODEX_|CLAUDE_|PYTHON|PERL5|RUBYOPT$|BASH_ENV$|ENV$|PATH$|HOME$|SHELL$|ZDOTDIR$|XDG_|SSL_CERT_|LC_|LANG$|OPENSSL_CONF$)/.test(
    name,
  );
}
export interface ResourcePolicy {
  timezone?: string;
  capacity: "personal" | "fallback" | "sandbox";
  /** Compatibility field: browser capability is always available per workspace. */
  browser: boolean;
  secrets: { ref: string; env: string }[];
}
export function resourcePolicy(value: unknown): ResourcePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("Expected a resource policy.");
  const input = value as Record<string, unknown>;
  if (
    !["personal", "fallback", "sandbox"].includes(String(input.capacity)) ||
    (input.browser !== undefined && typeof input.browser !== "boolean") ||
    !Array.isArray(input.secrets) ||
    input.secrets.length > 20
  )
    throw new HarnessError("Invalid capacity, browser or secret policy.");
  const seen = new Set<string>();
  const secrets = input.secrets.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.ref !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(item.ref) ||
      typeof item.env !== "string" ||
      !allowedSecretVariable(item.env) ||
      seen.has(item.env)
    )
      throw new HarnessError("Invalid or duplicate secret binding.");
    seen.add(item.env);
    return { ref: item.ref, env: item.env };
  });
  const timezone = typeof input.timezone === "string" ? input.timezone : "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new HarnessError("Use a valid IANA timezone.");
  }
  return {
    timezone,
    capacity: input.capacity as ResourcePolicy["capacity"],
    browser: true,
    secrets,
  };
}
/** A deployment chooses a backend; callers receive only explicitly granted refs. */
export interface SecretsEngine {
  read(
    reference: string,
    context: { workspaceId: string; turnId: string; generation: number },
  ): Promise<string>;
}
