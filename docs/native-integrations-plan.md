# Native email and Google Workspace tools

Status: implementation design; no runtime changes. Baseline: `origin/main` at
`f297ee6`. Worktree: `meta-harness-integrations`; branch: `feat/native-integrations`.

## Problem and result

Routine email, Drive, Docs and Sheets work should use bounded direct API operations
without opening a browser, scraping an editor or requiring a particular Mac.
Add Settings → Connections → Google accounts and workspace-specific tool bindings.
Read/search ships first, followed by drafts and explicitly enabled write operations.
Tools run through the existing authenticated harness MCP gateway; Claude/Codex
retain their native loops. This feature works without either the browser branch
or configurable upstream MCP connections. Eve remains a reference only.

## Existing seams and boundaries

- `apps/web/app/api/tools/route.ts` already authenticates each native attempt,
  exposes tools and derives sessions through worker/turn/generation identity.
- `apps/web/server/grants.ts` fences calls; `apps/worker/src/index.ts` supplies
  tool context and unfinished operations. Replace browser-only guidance with
  capability-aware instructions when these tools are available.
- `packages/core/src/resources.ts` defines pure resource and secret contracts.
  `apps/web/server/secrets.ts` currently resolves deployment variables only; it
  does not provide persistent account authorization or refresh-token storage.
- `packages/storage/src/application.ts` supplies workspace policy, transactional
  operations and receipts; reuse its turn/operation ownership checks.
- Keep JSON contracts/policy in core, persistence in storage, HTTP/OAuth transport
  and crypto in infrastructure adapters. Workflow directives/SDKs stay in
  `apps/web`. A new `packages/integrations` can implement engine-independent API
  adapters using bounded HTTP requests; no new orchestrator or agent process.

## Shared narrow tool contract

Define pure `ToolConnection`, `Capability` and `WorkspaceToolBinding` types with
IDs/revisions, effect (`read`, `write`, `unknown`), schemas and constraints, plus an
execution port returning bounded content/receipts from fenced attempt context.
Use the same small shape proposed for upstream MCP, but implement it locally here;
no dependency on that branch landing. A future merge should reconcile only this
contract/registry seam rather than coupling transport or OAuth implementations.

Expose `tool_connection_list` and `tool_connection_call` on the harness gateway.
List supplies this workspace's enabled account/capability descriptors and schemas;
call takes connection ID, capability ID, arguments and stable operation ID for
mutations. Native Google capability IDs remain concrete and documented, such as
`gmail.search` and `sheets.read_range`. Validate each with its own strict schema.
The dispatch surface can later gain named aliases without changing authorization.

## Accounts, credentials and minimal schema

Owner Google sign-in authenticates the harness owner. It does not authorize access
to Gmail, Drive, Docs or Sheets. Add a separate resource OAuth flow even when the
same person/account is selected; never reuse identity tokens or infer API consent.

| Record | Minimum values |
| --- | --- |
| `integration_connections` | ID, owner, provider=`google`, account subject/email label, enabled, revision, granted scope names, credential reference, status |
| `integration_workspace_bindings` | Workspace + connection key, revision, capabilities, file/range/account constraints, enabled |
| `integration_oauth_states` | Hashed single-use state, owner session binding, requested connection/scopes, PKCE verifier reference, expiry |
| `integration_credentials` | Connection reference, encrypted refresh-token payload/key version, token revision, expiry metadata; never returned in API DTOs |

Use additive SQLite/Prisma migrations and explicit export/import/cleanup handling.
Reserve integration-specific table/migration names, inspect current main before
allocating migration IDs, and avoid the MCP branch's namespace. Both features
stand alone; shared TypeScript descriptors are a tiny merge seam, not a new
orchestration framework. No command table or remote executor is needed initially.
Do not overwrite existing sessions, owner authentication or workspace resources.
Keep credential ciphertext distinct from ordinary connection metadata and backups
of its encryption key. Reuse audited encryption primitives where suitable, with a
dedicated domain/key configuration; fail closed if that key is missing. Document
key rotation, backup/restore, disconnect and provider revocation behavior.

OAuth start/callback routes require the owner session, exact registered redirect
URIs, expiring single-use state and PKCE. Persist granted scopes/account subject
from verified provider results. Request offline authorization incrementally for
chosen capabilities; handle absent refresh tokens without erasing an existing valid
one. Scope escalation is an owner action. Serialize refresh/token rotation using
credential revisions; `invalid_grant` becomes reconnect-needed, without retry loops.
Do not put provider error bodies, codes or tokens in logs/URLs/model-visible errors.

Access/refresh tokens stay in the credential broker and control-process API adapter,
never native agent env, argv, prompt, tool content, Workflow history or checkpoints.
No agent worker receives either token. Recheck scope/binding and assignment before
issuance and execution. Disabling access prevents future admissions; revoke credentials
and abort in-flight calls where possible. Revocation cannot undo completed actions.

## Settings and workspace authorization

Connection cards display the actual account, granted capability groups, reconnect
status and workspaces with access. Connect, reconnect, disconnect, test and scope
upgrade are owner-authenticated actions using existing origin/auth helpers and
optimistic revisions. No account is enabled in every workspace automatically.

The workspace selector binds one or more accounts with explicit labels; the agent
must name the connection when ambiguous. Default grants are read/search only.
Add separate toggles for drafts, document/sheet edits, and email sending when their
later slices ship. Show a
clear missing-scope/setup state rather than silently falling back to browser work.
Use the existing durable input path if the agent needs the owner to connect access.
Do not ask for credentials in conversation or introduce per-call generic approvals.

Derive owner/workspace/session from grants, not model arguments. Enforce capability
allowlists and resource restrictions inside the API adapter on every request. Google
OAuth scopes can exceed workspace policy: file/folder/label/range constraints are
harness restrictions, not claims that the provider issued a narrower token.
Folder grants require checking membership/shared-drive semantics, not path strings;
start with explicit file IDs if reliable folder enforcement is not implemented.

## Direct capability rollout

| Phase | Capability | Bounded behavior |
| --- | --- | --- |
| 1 | `gmail.search`, `gmail.read_thread` | Query/paged IDs, headers/snippets, bounded plain-text messages; attachments only by explicit request |
| 1 | `drive.search`, `drive.get_file` | Typed metadata, paged query, MIME-aware content/export with byte limits |
| 1 | `docs.read` | Structured document sections/text and revision metadata, with explicit truncation |
| 1 | `sheets.metadata`, `sheets.read_range` | File/tab IDs, explicit A1 ranges, bounded rows/columns, raw/formatted/formula representation |
| 2 | `gmail.create_draft`, `gmail.update_draft` | Exact recipients, subject, body and optional reply threading; receipt with draft/message IDs, never send |
| 3 | `docs.edit`, `sheets.write_range` | Validated narrow edits, revision/precondition where available, exact changed region and follow-up read |
| 3 | `drive.create_file`, `gmail.send_draft` | Explicit capability enablement, stable IDs/receipts, known provider-specific reconciliation |

Avoid destructive trash/delete, broad permission/sharing changes, arbitrary batch
requests and whole-account downloads in the first implementation. Add email
provider-neutral message/thread/draft values and a provider port; Gmail is the first
adapter. Microsoft/IMAP/SMTP remain extension points, not partially implemented flows.

Implement provider query escaping, shared-drive flags, page tokens bound to account
and request, MIME decoding, Docs tabs and Sheets tab/range selection deliberately.
Untrusted email/document content is returned as external data. Include source IDs,
links, representation, truncation and freshness; never claim complete content when
only a snippet/page was returned. Larger exports use existing scoped object ports.
For Sheets writes default to literal values; formulas require explicit arguments.

Before implementation, verify required scopes, export/read APIs, incremental/offline
OAuth, quota behavior and conditional-write support against official Google docs.
Record exact scope mapping in operations docs; do not guess that login scopes grant
data access or that all APIs support idempotency/compare-and-set. Gmail scopes may
carry provider verification/restricted-data requirements; document actual deployment
gates while keeping fixture development independent of real credentials.

## Placement, lifecycle and failure behavior

Execute ordinary Google HTTP calls through engine-independent adapters in the
existing control/API process. This already separates tool access from the agent's
Mac/Pi/Sandbox placement; stateless APIs need no dedicated worker. Keep OAuth/token
refresh there too. Open clients on demand, bound calls/results/pages to the gateway
request budget, honor rate-limit hints, and release resources after each call.
No new daemon, worker pool, command queue, remote lease, browser, mailbox indexer,
background sync or push subscription is required for the first shipped slice.

Long exports can later use the existing object port. Add remote tool execution only
if private network/local-file requirements appear; that later capability requires
explicit placement, scoped expiring access credentials, durable command receipts
and executor fencing. It must not become a prerequisite for public Google APIs.
Any optional Sandbox remains cold/budgeted and preserves state outside its disk.

Mutations require session + connection scoped logical IDs and canonical argument
hashes including relevant config/binding revisions. Reuse turn assignment/stop
checks and the operation ledger; guard outcome transitions against stale physical
attempts without introducing independent executor orchestration. Duplicate success
returns its original receipt; changing the arguments under an ID conflicts.
Persist remote IDs, affected resources and revision evidence, excluding tokens and
unnecessary message bodies. Preserve physical attempt evidence in the ledger.

Reads may retry bounded transient failures. Writes never retry blindly after
dispatch: a lost response may have succeeded. Record `not_started` only with clear
pre-execution evidence; only an explicit later call may retry that logical write.
Otherwise return `unknown_outcome`, surface it in unfinished-operation context,
and reconcile by provider IDs/current state. Draft creation and sending require
their own evidence; a message correlation marker alone is not exactly-once proof.
Docs/Sheets read-after-write does not create a compare-and-set guarantee. Native
execution interrupted by host loss is never automatically replayed.

## Checklist and validation

- [ ] M1: tiny contract, account/binding repository, encrypted credential
  store, scoped token broker, migrations and owner-only OAuth routes with fixtures.
- [ ] M2 (first shipped slice): Settings account/binding UI and phase-1 read/search,
  including Sheets range reads, through bounded HTTP adapters in the existing API
  process/gateway. Include source receipts and scoped OAuth setup documentation.
- [ ] M3 (later): drafts with operation fencing/reconciliation and scope upgrade.
- [ ] M4 (later): selected writes/send after fixture-tested provider semantics and
  explicit workspace capabilities; document unimplemented destructive operations.
- [ ] Test OAuth CSRF/state replay, wrong owner/account, redirect mismatch, missing
  refresh token, concurrent rotation, revoked grants and sanitized failures.
- [ ] Test workspace/file/range denial, stale binding/schema, duplicate calls,
  stale outcome writes, transport retry after success, timeout after external effect,
  pre-start failure, reconciliation, cancellation and agents on a separate machine
  from the control/API process. Later remote execution has separate fencing tests.
- [ ] Use Gmail/Drive/Docs/Sheets HTTP fixtures for pagination, MIME, Docs tabs,
  Sheets types/formulas, quota errors and bounded/partial content. Assert tokens
  never appear in model output, history, checkpoints, logs or stored receipts.
- [ ] Verify SQLite/Postgres parity, export/import and workspace deletion. Account
  disconnect blocks every binding for that connection without deleting remote
  mail/files; unbinding one workspace preserves other workspaces' access.
- [ ] Run `pnpm check`, `pnpm test`, `pnpm build` and `pnpm smoke` on an isolated
  local stack. No real account/model calls by default; any later live validation is
  intentionally selected and records external compatibility/deployment gates.

## New-session handoff prompt

Implement `docs/native-integrations-plan.md` in this worktree on
`feat/native-integrations`. Read AGENTS.md, README.md, docs/architecture.md, applicable
nested instructions and this plan; inspect git status. Build M1–M2 as the small
first shipped slice with fixtures and update checklist evidence. Leave drafts,
writes and remote execution as later work unless the session requests them.
Preserve existing native loops, engine
boundaries and all real data. Do not depend on browser or MCP-configuration branches.
Use pnpm, bounded control-process HTTP adapters and separate resource OAuth; never
expose tokens to agents. Run required checks plus local smoke. Preserve user changes
and use stacked PRs when publishing. Do not create cloud resources or enable paid
capacity for fixture development. Record external compatibility gates honestly.
