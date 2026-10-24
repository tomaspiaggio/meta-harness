import { HarnessError, requiredText } from "./index";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonSchema = JsonObject;
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  groupId?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: "read" | "write" | "unknown";
  schemaHash: string;
}
export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  revision: string;
  groups?: { id: string; name: string; description: string }[];
  tools: ToolDefinition[];
}
export interface IntegrationConnection {
  id: string;
  integrationId: string;
  adapter: "native" | "mcp";
  label: string;
  revision: string;
  enabled: boolean;
  config: JsonObject;
  credentialRef?: string;
}
export interface WorkspaceIntegrationBinding {
  workspaceId: string;
  connectionId: string;
  revision: string;
  connectionRevision: string;
  integrationRevision: string;
  toolIds: string[];
  constraints: JsonObject;
  enabled: boolean;
}
/** Infrastructure supplies auth, networking and cancellation; core owns no SDK. */
export interface IntegrationAdapter {
  id: string;
  discover(
    connection: IntegrationConnection,
    signal: AbortSignal,
  ): Promise<IntegrationDefinition>;
  execute(input: {
    connection: IntegrationConnection;
    tool: ToolDefinition;
    arguments: JsonObject;
    constraints: JsonObject;
    workspaceId: string;
    signal: AbortSignal;
  }): Promise<JsonValue>;
}
export function jsonObject(value: unknown, name = "Object"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError(`${name} must be an object.`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 262144)
    throw new HarnessError(`${name} exceeds 256 KiB.`);
  return JSON.parse(serialized) as JsonObject;
}
export function integrationId(value: unknown): string {
  const id = requiredText(value, "Identifier", 100);
  if (!/^[a-zA-Z0-9_.-]+$/.test(id))
    throw new HarnessError("Invalid integration identifier.");
  return id;
}
export function parseIntegrationDefinition(
  value: unknown,
): IntegrationDefinition {
  const v = jsonObject(value);
  if (!Array.isArray(v.tools) || v.tools.length > 100)
    throw new HarnessError("Integration must contain at most 100 tools.");
  const tools = v.tools.map((item) => {
    const t = jsonObject(item);
    if (!["read", "write", "unknown"].includes(String(t.effect)))
      throw new HarnessError("Invalid tool effect.");
    return {
      id: integrationId(t.id),
      name: requiredText(t.name, "Tool name", 100),
      description: requiredText(t.description, "Tool description", 8000),
      ...(t.groupId ? { groupId: integrationId(t.groupId) } : {}),
      inputSchema: jsonObject(t.inputSchema, "Input schema"),
      ...(t.outputSchema ? { outputSchema: jsonObject(t.outputSchema) } : {}),
      effect: t.effect as ToolDefinition["effect"],
      schemaHash: requiredText(t.schemaHash, "Schema hash", 128),
    };
  });
  if (new Set(tools.map((t) => t.id)).size !== tools.length)
    throw new HarnessError("Duplicate tool IDs.");
  const groups = Array.isArray(v.groups)
    ? v.groups.map((item) => {
        const g = jsonObject(item);
        return {
          id: integrationId(g.id),
          name: requiredText(g.name, "Group name", 100),
          description: requiredText(g.description, "Group description", 2000),
        };
      })
    : undefined;
  return {
    id: integrationId(v.id),
    name: requiredText(v.name, "Integration name", 100),
    description: requiredText(v.description, "Description", 8000),
    revision: requiredText(v.revision, "Revision", 128),
    tools,
    ...(groups ? { groups } : {}),
  };
}
export function parseIntegrationConnection(
  value: unknown,
): IntegrationConnection {
  const v = jsonObject(value);
  if (v.adapter !== "native" && v.adapter !== "mcp")
    throw new HarnessError("Invalid integration adapter.");
  if (typeof v.enabled !== "boolean")
    throw new HarnessError("Enabled must be boolean.");
  return {
    id: integrationId(v.id),
    integrationId: integrationId(v.integrationId),
    adapter: v.adapter,
    label: requiredText(v.label, "Connection label", 100),
    revision: requiredText(v.revision, "Revision", 128),
    enabled: v.enabled,
    config: jsonObject(v.config),
    ...(v.credentialRef
      ? { credentialRef: integrationId(v.credentialRef) }
      : {}),
  };
}
export function parseIntegrationBinding(
  value: unknown,
): WorkspaceIntegrationBinding {
  const v = jsonObject(value);
  if (
    typeof v.enabled !== "boolean" ||
    !Array.isArray(v.toolIds) ||
    v.toolIds.length > 100
  )
    throw new HarnessError("Invalid workspace binding.");
  return {
    workspaceId: integrationId(v.workspaceId),
    connectionId: integrationId(v.connectionId),
    revision: requiredText(v.revision, "Revision", 128),
    connectionRevision: requiredText(
      v.connectionRevision,
      "Connection revision",
      128,
    ),
    integrationRevision: requiredText(
      v.integrationRevision,
      "Integration revision",
      128,
    ),
    toolIds: [...new Set(v.toolIds.map(integrationId))],
    constraints: jsonObject(v.constraints),
    enabled: v.enabled,
  };
}
