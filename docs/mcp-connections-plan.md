# Workspace MCP connections

Status: implementation design; no runtime changes. Baseline: `origin/main` at
`f297ee6`. Worktree: `meta-harness-mcp`; branch: `feat/mcp-connections`.

## Problem and result

The harness exposes its own MCP gateway but cannot configure arbitrary upstream
servers. Add Settings → Connections → MCP so the owner can register an HTTP or
stdio server, inspect its tools, and bind selected capabilities to workspaces.
Ship reachable HTTP first; add stdio/private-host execution as a later slice.
Claude and Codex keep their native loops and consume the existing harness gateway.
An agent on a Pi can use a server hosted on a Mac or compatible cold Sandbox;
neither the agent machine nor a particular personal machine defines identity.

This feature stands alone. It needs neither the browser branch nor direct Google
integrations. Eve remains a reference, never a runtime dependency.

## Existing seams to preserve

- `apps/web/app/api/tools/route.ts`: stateless authenticated MCP gateway; verifies
  attempt grants and assignment before calls. Currently lists a static tool set.
- `apps/web/server/grants.ts`: worker/turn/generation/expiry bearer identity.
- `packages/runtimes/src/index.ts`: Codex ignores user configuration; Claude uses
  strict MCP configuration. Both receive only the harness gateway and scoped token.
- `packages/core/src/resources.ts`: workspace resource policy and `SecretsEngine`.
  Current secrets backend in `apps/web/server/secrets.ts` resolves deployment
  variables; ordinary workspace secrets become native process environment values.
- `packages/storage/src/application.ts`: `operation`, `operationOutcome`, and
  `unfinishedOperations`; stable argument hashing and session ownership already
  exist. Reuse these turn/operation ownership checks and stored receipts.
- `packages/storage/src/features-schema.ts` and Prisma migrations implement both
  database paths. Worker RPC already supports authenticated outbound polling.

## Narrow connection contract

Put JSON types, validation and policy decisions in a new core module. Define
`ToolConnection { id, kind, name, revision, enabled, config }`,
`Capability { id, inputSchema, effect, schemaHash }`, and
`WorkspaceToolBinding { workspaceId, connectionId, revision, capabilities,
constraints }`. Effects are `read`, `write`, or `unknown`; unknown means mutating.
An execution port accepts a connection, capability, arguments and fenced context;
it returns bounded content plus a durable execution receipt.

Keep this contract small enough for a future native integration to implement.
Do not add native integration code or require its branch. External MCP libraries,
Node subprocess code and database implementations stay outside core. Workflow
SDK imports/directives stay in `apps/web`; no second model/tool loop is introduced.

## Minimal persistence and configuration

Add separate tables rather than placing secrets/configuration in workspace policy:

| Record | Minimum values |
| --- | --- |
| `mcp_connections` | ID, owner, label, enabled, revision, transport/config JSON, credential reference, timestamps |
| `mcp_workspace_bindings` | Workspace + connection key, revision, enabled tool IDs, constraints, enabled flag |
| `mcp_capability_snapshots` | Connection revision, bounded descriptors/schema hashes, discovery time/status |

Use MCP-specific table/migration names so this branch and native integrations can
land independently. Allocate the migration after inspecting current main; do not
reuse another branch's migration ID. Shared TypeScript types are a small seam to
reconcile on merge, not shared infrastructure that either feature must wait for.
The first HTTP slice adds no tool command table, queue or executor lease.

HTTP config: endpoint, approved destination policy and header-name → secret-ref
bindings. Support Streamable HTTP first; explicitly report unsupported legacy SSE,
resources, prompts, sampling, elicitation and server-initiated operations. Arbitrary
means owner-selected compatible tool servers, not a claim to every MCP extension.
Verify current protocol/SDK compatibility from official docs during implementation.

Stdio config: executable plus argument array, optional approved working directory,
environment-name → secret-ref bindings, compatible platforms/architectures and
placement (`eligible` with labels or explicit worker pin). No shell command strings,
automatic `npx` downloads, startup package installation or imported global configs.
Executable installation belongs to the selected host's documented setup.

Connection credentials initially use existing server-side secret references;
provide missing-secret status and setup instructions. Do not expose a pretend
secret editor backed by plaintext settings. OAuth-only upstream servers require a
separate connector authorization milestone; bearer/header authentication ships first.
Secret values never enter model context, native CLI environment, argv, descriptors,
receipts or Workflow history. Deliver only required values to the tool host.

## Settings and access

Owner-authenticated endpoints list/create/revise/delete connections, test discovery,
and manage workspace bindings; use existing origin/auth helpers and revision checks.
Connection cards show transport, placement, available tools, last explicit test,
missing prerequisites and workspaces using the connection. Creation grants nothing.
The workspace selector shows enabled capabilities, effect classification and host
availability; allow binding a subset and disabling immediately. Do not auto-enable
new upstream tools after discovery. A schema change requires a new accepted binding.

Add `tool_connection_list` and `tool_connection_call` to the existing gateway.
List returns only this workspace's enabled descriptors, with bounded/paged schemas.
Call takes `connection_id`, `capability_id`, `arguments`, and `operation_id` for
writes/unknown effects. Validate arguments against the accepted schema. Keep upstream
names in the capability ID so collisions cannot shadow built-in harness tools.
This small dispatch surface avoids unbounded tool-list expansion on each turn.

Derive workspace/session exclusively from the attempt grant. Recheck connection,
binding revisions, current assignment, stop state and capability restrictions at
admission and immediately before execution. Upstream read-only annotations are
hints, not authorization. The owner accepts the allowed capabilities and effects;
the proxy cannot promise upstream code honors a declared read-only policy.

Disabling a binding prevents future admissions. Attempt to abort active
I/O but record unknown outcomes if it may have acted. Deleting a workspace removes
its bindings through existing cleanup semantics; shared connections
remain for other workspaces. Deleting a connection disables use before cleanup.

## Placement and cold lifecycle

The shipped first slice calls reachable HTTP MCP servers from the existing
control/API process through an engine-independent adapter. Agent execution can be
on a Pi, Mac or Sandbox without changing this path. Open the HTTP client only when
called; bound connection/read duration, discovery size and result bytes within the
gateway request budget, then release it. No new worker lane, queue, lease, pool,
daemon or service is needed. Do not invent asynchronous command orchestration for
ordinary bounded HTTP calls. Long-running protocol tasks remain unsupported first.

Network access is evaluated from the control/API process. HTTPS is the default; explicitly
registered private/loopback destinations may be used on their intended host.
Never infer that `localhost` means the control plane or agent machine. Block
metadata/control-plane targets by default, validate resolved destinations/redirects,
and never forward auth headers to another origin. Reachability failure reports the
actual endpoint/setup issue without starting browser or agent processes.

Later capability: add remote tool execution only for stdio, private-host endpoints
or local-file requirements the control process cannot satisfy. Extend existing
worker reports and outbound RPC with the necessary adapter/platform/resource
capabilities and explicit placement. This later slice needs durable commands,
executor-generation fencing and per-attempt receipts before execution is enabled.
Compatible Mac/Pi workers or optional cold/budgeted Sandbox can supply it; no machine
is mandatory. Start stdio children only for active use, bound subprocess trees,
stderr and request duration, then close on idle/cancellation/shutdown. Kill only
owned children. Persist required state externally to ephemeral Sandbox disks.
An offline pinned host reports unavailable; never silently substitute identity.

## Effects, receipts and failure handling

Namespace logical IDs by session + connection + owner/model operation ID. Hash
connection/binding/schema revisions, tool name and canonical arguments; same ID
with different effective arguments conflicts. Persist admission before HTTP I/O.
Reuse turn assignment/stop checks and the existing operation ledger; guard outcome
transitions against stale attempts so old requests cannot overwrite receipts. This
is a narrow operation guard, not a new executor framework. A successful
repeat returns the saved receipt. Pre-execution rejection records `not_started`;
an explicit retry may reuse the logical ID with a new physical attempt. Once sent,
timeout, disconnect or host loss means `unknown_outcome` unless evidence proves
otherwise. Surface unknowns through existing unfinished-operation context.

Use upstream idempotency only where explicitly supported. General MCP calls do
not imply exactly-once external effects. Reconciliation queries/owner inspection
must precede repeating an ambiguous write; changing operation IDs is not a remedy.
Native turns interrupted by any worker loss are never automatically retried.
Bound/redact persisted results; tool text is untrusted external data, not policy.

## Implementation checklist and verification

- [ ] M1: pure contract/validation; additive SQLite and Prisma migrations; repository
  methods with owner/workspace scope and optimistic revisions; export/import and
  workspace-deletion coverage. Existing resource policies remain intact.
- [ ] M2 (first shipped slice): HTTP fixture server, discovery/bind UI, gateway
  list/call, bounded control-process adapter and existing operation receipts.
  Include setup docs and supported protocol/authentication matrix.
- [ ] M3 (later): stdio/private-host/local-file execution, explicit placement,
  durable remote commands and executor fencing; lazy child lifecycle and cleanup.
- [ ] M4 (later): upstream OAuth and prepared-image Sandbox support as needed.
- [ ] Fixtures: cross-workspace denial, revoked binding during I/O, stale schema,
  duplicate HTTP calls, same-ID argument conflicts, unknown outcomes,
  pre-start retry, stale outcome fencing, cancellation and crash after execution.
- [ ] Fixtures: malformed/oversized schemas/content, pagination, HTTP redirects,
  secret redaction and operation ownership. Later remote fixtures additionally
  cover duplicate claims, subprocess exit/hang, idle cleanup and separate hosts.
- [ ] Run `pnpm check`, `pnpm test`, `pnpm build`; execute `pnpm smoke` against an
  isolated local stack for execution changes. Provider CLI tests use fixtures.
  Do not install services, use real credentials or make live model calls by default.

## New-session handoff prompt

Implement `docs/mcp-connections-plan.md` in this worktree on
`feat/mcp-connections`. First read AGENTS.md, README.md, docs/architecture.md,
the applicable nested instructions and this plan; inspect git status. Implement
M1–M2 as the small first shipped slice, updating checklist verification. Leave
remote execution and upstream OAuth as later work unless the session requests them.
Keep the existing native loops and attempt-scoped gateway; preserve data and engine
boundaries. Do not depend on browser or native-integration branches. Use pnpm and
fixtures, bound HTTP calls in the existing API process, and run all required checks
plus local smoke. Preserve user changes and use stacked PRs when publishing.
Do not create cloud resources or enable paid capacity for fixture development.
Record external compatibility gates honestly.
