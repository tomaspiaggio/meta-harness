# Meta Harness

A local workspace UI and worker, with Vercel Workflow coordinating durable turns.
Built with pnpm, Turborepo, Next.js, and TypeScript. No Docker, Postgres, Redis,
or always-running agent processes are needed for this first slice.

## Run locally

Requires Node **24+** and pnpm **10.10.0**. SQLite uses Node's built-in `node:sqlite`
(Node currently prints an experimental-feature notice).

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:3000**. Start with **Demo** to exercise the real Workflow →
SQLite queue → worker → saved output path without an account or model calls.
Business, Tech, and Fundraising are seeded; create additional workspaces in the UI.
Each workspace can contain independent sessions.

For everyday use with less memory than the development compiler:

```sh
pnpm build
pnpm start
```

`Ctrl+C` stops this repository's services and active agent processes. Other apps,
shells, and agent sessions are unaffected. Never run `dev` and `start` on the same
port at the same time.

## Real agents

Install and sign into Codex CLI or Claude Code separately, then select that
provider when creating a session. This version uses their noninteractive CLI
interfaces. Credentials stay in the provider's local authentication store; the
application saves a native session ID and resumes that ID on subsequent turns.
No API key is needed for Demo. Actual provider access depends on your CLI login
and account entitlement.

- Codex: `codex exec --json`, then `codex exec resume <native-id> --json`.
  Workspace-write sandbox, approvals set to never; no bypass flag. User config
  is disabled for this invocation so global MCP services do not start for every
  harness turn. Auth still uses the CLI's existing credential store.
- Claude: `claude --print --output-format stream-json`, then `--resume <native-id>`.
  Permission mode is `dontAsk`; operations that need a permission prompt may be
  denied. No permission bypass. Global MCP configurations are excluded.
- Both start on demand and exit after each turn. Each session gets its own
  working directory under `.data/sessions/<session-id>`.
- Output appears as provider messages arrive; this is message streaming, not
  token-by-token rendering. Provider errors and partial output remain visible.

CLI event parsing and subprocess behavior are covered with fixtures. Live model
calls, provider login, and real native-session continuation still need validation
against your selected CLI versions/accounts. Interactive approvals, app-server,
and the Claude Agent SDK are subsequent runtime adapters, not implemented here.

## Memory and concurrency

Only the web service and a small worker stay resident. The launcher starts Node
directly, avoiding a pnpm/watch supervisor for each service. There are no package
build watchers. The UI pauses refreshes in hidden tabs and refreshes idle sessions
less frequently. SQLite's page cache is configured to approximately 2 MiB per
connection; output per turn and the visible history window are bounded.

By default, **one turn runs at a time in this harness**; other sessions queue.
This does not limit any other tools running on your machine. Increase it freely:

```sh
HARNESS_CONCURRENCY=3 pnpm dev
```

Copy `.env.example` to `.env` for persistent overrides. `HARNESS_TURN_TIMEOUT_MS`
defaults to 30 minutes per turn; `HARNESS_POLL_MS` defaults to 1000. No global
Node heap limit, system resource limit, or machine-wide process setting is changed.
Agent subprocess memory is additional to the idle footprint.

## Package boundaries

```text
apps/web                  Next.js UI, HTTP transport, Workflow composition
  workflows/              thin "use workflow" / "use step" wrappers
  server/                 local persistence wiring and dispatch outbox
apps/worker               polling, leases, shutdown, runtime construction
packages/core             plain functions, contracts, execution policy
packages/storage          SQLite implementation
packages/runtimes         Demo, Codex CLI, Claude CLI adapters
```

`core` imports neither Workflow nor infrastructure. SDK directives live in the
web composition root. A Temporal TypeScript worker can wrap the same application
functions in activities; workflow logic, durable waits, and deployment wiring
would be rewritten. Existing Workflow histories would not migrate automatically.
`pnpm check` enforces the package boundaries.

See [architecture](docs/architecture.md) for the Eve references and tradeoffs.

## Persistence and recovery

The launcher puts application state in `.data/harness.sqlite` and Workflow state
in `.data/workflow`. Set `HARNESS_DATA_DIR` to an absolute directory to relocate
both. Provider-native transcripts remain in their normal CLI-managed stores;
copying `.data` alone is **not** a portable provider checkpoint.

- Turn submission uses a stable client-generated ID; conflicting reuse is rejected.
- A pending turn is the dispatch outbox. The web process retries undispatched
  records every five seconds, including after restart. Dispatch is at least once;
  enqueue and worker claims are idempotent, so duplicate orchestration runs cannot
  execute the same turn twice.
- At most one active turn can mutate a session. Multiple workers sharing this
  local database claim turns atomically.
- A worker renews a 30-second ownership lease. After expiry, the next claim scan
  marks the turn interrupted and fences its writes. Interrupted agent turns are
  never retried automatically: inspect partial results and submit a new instruction.
- A graceful shutdown terminates the current provider process and records an
  interruption. A hard kill is detected after lease expiry when a worker runs again.

This is a **single-machine implementation**, bound to loopback. SQLite isn't the
future distributed queue, and a local filesystem isn't Vercel-hosted persistence.
The local Workflow world is a development backend; production durability requires
the hosted world or another supported persistent backend. Browser takeover,
cross-workspace memory, artifacts, portable checkpoint bundles, remote enrollment,
and Vercel deployment are not implemented yet.

## Verify

```sh
pnpm check
pnpm test
pnpm build
pnpm test:restart
# While dev or start is running:
pnpm smoke
```

Inspect the same Workflow data directory as the running app:

```sh
pnpm workflow inspect runs
pnpm workflow inspect run <run-id>
pnpm workflow inspect events --runId <run-id> --json
# Optional inspector server, only when you need it:
pnpm workflow web
```

Runtime failures can be reproduced through `createRuntime().run()` and
`executeTurn()` without a Workflow build. The CLI fixtures in `packages/runtimes`
demonstrate this. Application output/errors are in SQLite; orchestration events
are in the Workflow inspector. Worker logs include the stable application turn ID.

The launcher explicitly selects the local world: the pinned Next.js integration
otherwise overrides `WORKFLOW_LOCAL_DATA_DIR` with `.next/workflow-data` when
it infers the world automatically. Keeping state outside `.next` avoids losing it
to builds and makes the inspector and server read the same directory.

Tests exercise idempotency, independent database connections, process-restart
persistence, session exclusion, stale ownership, output limits, provider events,
completion detection, and subprocess cancellation. The smoke check sends two
Demo turns through actual workflows and the worker, verifies continuation and
duplicate submission, and checks cross-origin rejection. It creates a test session
in the Tech workspace without making model calls.

`test:restart` uses a temporary database and an available loopback port. It
restarts the production web process with a queued turn, then starts the worker
and checks that the original workflow resumes and the turn executes once.
