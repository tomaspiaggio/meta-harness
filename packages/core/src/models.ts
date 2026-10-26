import { HarnessError, type Provider } from "./index";
export type AgentProvider = "claude" | "codex";
export interface AgentDefaults {
  provider: AgentProvider;
  models: Record<AgentProvider, string | null>;
}
export const defaultAgentDefaults: AgentDefaults = {
  provider: "claude",
  models: { claude: null, codex: null },
};
/** Suggestions, not an account entitlement list. Custom IDs remain supported. */
export const modelSuggestions = {
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "Sol · GPT-6.1" },
    { id: "gpt-6.1-terra", label: "Terra · GPT-6.1" },
    { id: "gpt-6-astra", label: "Astra · GPT-6" },
    { id: "gpt-6-luna", label: "Luna · GPT-6" },
    { id: "gpt-6-sol", label: "Sol · GPT-6" },
  ],
} satisfies Record<AgentProvider, { id: string; label: string }[]>;
export function parseModel(provider: Provider, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    provider === "demo" ||
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,159}$/.test(value)
  )
    throw new HarnessError("Choose a valid model ID for this agent.");
  if (
    (provider === "claude" && /^(gpt-|codex-)/i.test(value)) ||
    (provider === "codex" &&
      /^(claude-|opus(?:\[|$)|sonnet(?:\[|$)|haiku(?:\[|$)|fable$)/i.test(
        value,
      ))
  )
    throw new HarnessError(
      "That model belongs to the other agent. Create a separate session to change agents.",
    );
  return value;
}
export function parseAgentDefaults(value: unknown): AgentDefaults {
  const row = value as Partial<AgentDefaults> | null;
  if (
    !row ||
    !["claude", "codex"].includes(row.provider ?? "") ||
    !row.models ||
    typeof row.models !== "object"
  )
    throw new HarnessError("Choose Claude or Codex and their default models.");
  return {
    provider: row.provider as AgentProvider,
    models: {
      claude: parseModel("claude", row.models.claude),
      codex: parseModel("codex", row.models.codex),
    },
  };
}
