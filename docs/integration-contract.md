# Unified integration contract

Status: foundation implemented, 2026-10-23; adapters ship independently. This document is
identical in the MCP and native-integration worktrees. Implement the common
foundation once, then build the adapters independently against its ports.

## Domain language

An **integration** is a named, described collection of related tools. MCP is one
way to supply that collection; a native API adapter is another. An integration is
not a single action, account, agent process or mandatory daemon.

| Entity | Responsibility | Example |
| --- | --- | --- |
| Integration definition | Reusable collection, description, optional groups and tool definitions | Google Workspace, Notion, a configured MCP service |
| Tool group | Optional described subset for organization/discovery; no implicit permission | Gmail, Drive, Docs, Sheets |
| Tool definition | One action's description, schema and effect classification | Search mail, read a sheet range |
| Connection | Configured integration instance and account/endpoint, with credential references | Work Google account, personal Google account, work Notion MCP |
| Workspace binding | Allowed connection, tool subset, revisions and resource constraints | Business may read work CRM sheets |
| Adapter | Discovery/auth/execution implementation behind the contract | Native Google REST adapter, MCP HTTP adapter |

Keep connection identity separate from the definition. Two Google accounts share
one integration definition and have independent connections and workspace grants.
A future native Notion or finance adapter fits the same contract without changing
the agent runtime. A tool group is descriptive: granting a group must resolve to
an explicit accepted tool set, not automatically grant future tools.

## Minimal pure types

Use plain JSON values in core; provider SDKs, auth and execution live in adapters.

```ts
interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  revision: string;
  groups?: { id: string; name: string; description: string }[];
  tools: ToolDefinition[];
}
interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  groupId?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: "read" | "write" | "unknown";
  schemaHash: string;
}
interface IntegrationConnection {
  id: string;
  integrationId: string;
  adapter: "native" | "mcp";
  label: string;
  revision: string;
  enabled: boolean;
  config: JsonObject;
  credentialRef?: string;
}
interface WorkspaceIntegrationBinding {
  workspaceId: string;
  connectionId: string;
  revision: string;
  toolIds: string[];
  constraints: JsonObject;
  enabled: boolean;
}
```

JsonSchema/JsonObject are placeholders for the project's JSON types, not SDK
imports. Adapter-specific settings and authorization metadata can extend validated
config; model-visible projections exclude config and credential references.
Descriptions explain intent and limitations; they never confer authorization.
MCP descriptions/annotations are untrusted upstream data. Unknown effects default
to mutating policy until explicitly classified.

## Common model-facing surface

Present every enabled tool through the existing harness MCP gateway with the
same fields: a stable namespaced model name, description and input schema, plus
supported output schema/annotations. A native Gmail tool is not a special calling
convention compared with a proxied Notion MCP tool. The gateway maps the model name
back to connection ID, tool ID and accepted revisions; it validates arguments,
workspace access, ownership and operation identity before invoking the adapter.
Do not let upstream names shadow harness tools or collide across accounts.

The model also receives a compact integration catalog: connection label, purpose,
available tool groups and access limits. Start with bounded enabled tool lists.
If catalogs grow, discover tools by integration/group on demand using the same
descriptors; do not introduce separate MCP/native routers or eagerly inject every
integration's full schemas into every turn. Whichever projection is used, preserve
tool descriptions/schemas and the same call/receipt semantics.

Example: Google Workspace / Work account / Gmail group exposes a described
`gmail.search` action; Notion / Work MCP exposes a described `search` action. The
transport and credential handling are adapter details. Account labels and access
limits remain visible so the agent can select the correct connection.

## Common owner interface and persistence

Use **Settings → Integrations**, with a common connection list and workspace
bindings. Add integration offers native presets or a custom MCP server. Every
card shows purpose, account/endpoint label, tool groups, enabled tools, health and
workspaces with access. Adapter-specific setup is nested inside that flow.

Implement the shared definition/connection/binding registry and gateway projection
once in a small foundation change. Use common records rather than two competing
MCP/native catalogs. Adapter-specific discovery snapshots, OAuth states and
credential ciphertext use separate extension tables/migrations. Bindings and
revocation semantics stay common. Keep secrets out of descriptors/model context.

Both adapter branches can implement and test against these ports before the
foundation lands, using fixtures. Integrate the same foundation commit into each
branch when available; do not duplicate registry/schema implementations and plan
to merge them later. Neither adapter depends on the other's implementation or the
browser feature. Ordinary HTTP calls run cold in the existing control/API process;
remote stdio/private-host execution remains a later capability.

## Acceptance gates

- [ ] A native collection and an MCP collection register against identical ports.
- [ ] Both appear in the same owner UI and workspace binding selector.
- [ ] Model-facing tools preserve descriptions/schemas with collision-free names.
- [ ] Multiple connections/accounts stay distinct without duplicating definitions.
- [ ] Disabled/revised grants and newly discovered tools obey the same policy.
- [ ] Receipts, ownership fencing and unknown outcomes are transport-independent.
- [ ] A fixture third adapter (e.g. Notion/finance) fits without runtime/provider changes.

## Foundation implementation

`packages/core/src/integrations.ts` provides the shared pure contracts and parsers.
`HarnessStore` persists definitions, connections and workspace bindings through the
same SQL adapter on SQLite and Prisma/Postgres. Updates require the old revision;
bindings accept exact definition/connection revisions and explicit tool IDs.
Database export discovers these common tables and preserves their relationships.
Deleting a workspace removes its bindings; deleting a connection removes its grants.

`apps/web/server/integrations.ts` registers cold adapters by `config.adapterId`
(defaulting to the connection adapter), projects bounded namespaced gateway tools,
validates arguments and records transport-independent receipts. Tool calls wrap
upstream arguments in `arguments`, plus `operation_id` for writes/unknown effects;
`retry_unstarted` explicitly retries proven pre-execution rejection. A physical
attempt token fences terminal receipt updates. Stop, grant and revision checks run
before execution and during active I/O; uncertain effects remain unknown.
Adapters receive the accepted workspace constraints and abort signal and must
apply resource limits and redact secrets from results and errors.

Settings contains the common registry and reviewed per-workspace tool selector.
Adapter setup components can use its `setup` slot and dispatch the browser event
`integrations-changed` after mutations. Shared owner APIs live at
`/api/integrations`; adapter-specific setup/auth routes remain separate.

Foundation verification: `pnpm check`, `pnpm test` (86 pass, seven existing skips),
`pnpm build`, and local `pnpm smoke` on fixture port 3211. The fixture third adapter
covers names/schema preservation, workspace denial, schema revision rejection,
duplicate calls, argument conflicts, revocation during I/O and unknown outcomes.
Postgres migration is provided; real Postgres deployment remains an external gate.
