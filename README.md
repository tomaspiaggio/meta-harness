# Meta Harness

A local workspace UI and worker, with Vercel Workflow coordinating durable turns.
Built with pnpm, Turborepo, Next.js, and TypeScript. The lightweight local default
needs no Docker, PostgreSQL, Redis or idle agent processes. Optional Prisma/Postgres,
hosted authentication, schedules, attachments, managed browser takeover, Telegram
topics and cold Sandbox capacity are implemented behind explicit configuration.

See [operations and validation](docs/operations.md) and the
[implementation checklist](docs/implementation-checklist.md) for setup and remaining
real-host/deployment gates.

## Run locally

Requires Node **24+** and pnpm **10.10.0**. SQLite uses Node's built-in `node:sqlite`
(Node currently prints an experimental-feature notice).

```sh
git clone --branch main https://github.com/tomaspiaggio/meta-harness.git
cd meta-harness
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:3000** locally, or **http://<machine-name>:3000** from
another device on your private network. The launcher listens on **0.0.0.0** by
default; set `HARNESS_BIND_HOST=127.0.0.1` for loopback-only operation.
Business, Tech, and Fundraising are seeded; create additional workspaces in the UI.
Each workspace can contain independent sessions. Open **/tasks** for the durable
backlog, worker capacity, pause controls, worker targeting, and draining.
**/schedules** reviews and manages persistent-session schedules. **/settings**
configures resources, timezone, workers and Telegram. Paste/drop files in the
composer; use its Browser panel for screenshots and manual login takeover.

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
Actual provider access depends on your CLI login
and account entitlement.

- Codex: `codex exec --json`, then `codex exec resume <native-id> --json`.
  Approvals set to never. User config is disabled for this invocation so global
  MCP services do not start for every harness turn. Auth still uses the CLI's
  existing credential store.
- Claude: `claude --print --output-format stream-json`, then `--resume <native-id>`.
  Global MCP configurations are excluded.
- Permissions: full access by default, like `claude
  --dangerously-skip-permissions` (Codex `danger-full-access`). A session can be
  sandboxed under Advanced in the chat (Claude `dontAsk` with a narrow Edit rule
  for the decision file; Codex `workspace-write`). `HARNESS_AGENT_PERMISSIONS=sandboxed`
  sandboxes every session on a worker; isolated Linux workers are always sandboxed.
- Both start on demand and exit after each turn. Each session gets its own
  scratch directory under `.data/worker-cache/<worker-id>/sessions/<session-id>`.
  A workspace can name a working folder (Advanced in the chat); on machines where
  it exists, agents get access to it (Claude `--add-dir`, loading its CLAUDE.md)
  and are told to work there.
- Output appears as provider messages arrive; this is message streaming, not
  token-by-token rendering. Provider errors and partial output remain visible.

CLI event parsing and subprocess behavior are covered with fixtures. The shared
knowledge bench also passed with live Claude and Codex calls, same-machine native
continuation, and a control/worker restart on the tested installation. Other
versions/accounts and cross-host native portability still need validation.
Interactive approvals and app-server are not implemented. The optional Claude
Agent SDK adapter remains experimental; see its compatibility gate below.

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

A conversation agent mostly waits on its model (about 100–350 MB, near-idle
CPU), so it reserves 384 MiB and no CPU slot; only builds and browsers reserve
CPU. A machine takes another agent while its harness memory budget
(`HARNESS_MEMORY_BUDGET_MIB`, default half its RAM) and free memory allow, up to
`HARNESS_CONCURRENCY`. The owner's messages and planners are claimed before work
between sessions (tasks, notes), and background work never takes a machine's
last slot, so a question never waits behind workers.

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
packages/storage          async SQLite / Prisma-Postgres and object adapters
packages/runtimes         Demo, Codex CLI, Claude CLI / optional SDK adapters
packages/mcp              cold, bounded upstream MCP Streamable HTTP adapter

packages/integrations     bounded Google resource OAuth and read-only HTTP adapters
packages/browser          on-demand Patchright and encrypted takeover transport
packages/checkpoints      portable file manifests and encrypted payload transport
```

`core` imports neither Workflow nor infrastructure. SDK directives live in the
web composition root. A Temporal TypeScript worker can wrap the same application
functions in activities; workflow logic, durable waits, and deployment wiring
would be rewritten. Existing Workflow histories would not migrate automatically.
`pnpm check` enforces the package boundaries.

See [architecture](docs/architecture.md) for the Eve references and tradeoffs.
The [implementation checklist](docs/implementation-checklist.md) tracks the agreed
hosted architecture, Prisma/Postgres migration, schedules, attachments, browser
takeover, and Telegram topics. Unchecked items include external deployment and
compatibility gates; implemented code is distinguished from real-host validation.

## Conversation controls

You can send messages while a turn runs: **Send next** queues a new turn in that
session; **Interrupt and send** records a stop request and queues your correction
atomically. Only one turn executes per session, in submission order. There is a
100-message waiting limit per session. Separate sessions can execute concurrently
subject to the worker's capacity policy.

**Stop** cancels a waiting turn immediately. For running turns it shows
**Stopping** until the worker terminates its provider process and acknowledges the
interruption (normally within the five-second heartbeat interval, plus termination
time). Partial output remains visible. This does not undo external actions or
automatically replay the interrupted turn. Stop requests survive control restarts.
Restart existing workers when updating to this release so they consume stop commands.
The task board also offers **Stop turn**; pausing a task still only blocks new claims.

Session results and failures create durable unread updates, including when the tab
is closed. Unread sessions sort first and collapsed workspaces show their unread
count. Viewing the session at the bottom acknowledges the displayed result cursor,
without clearing updates that arrive later. Old pre-upgrade history starts read.
Use the pencil beside a sidebar session to rename it; manual names also update the
task board and are protected from automatic title generation. Optional utility
model naming and the local fallback are described in the operations guide.
The offline fallback extracts short topic words rather than repeating the opening
sentence. During native work, the agent can suggest a better title through its
scoped `session_title` tool, without another model request; manual titles win.
Decisions can be edited or deleted in their tab. Delete records a withdrawal;
use **Show withdrawn decisions → Restore** to bring one back. Earlier revisions
remain stored, and stale edits are rejected.

In **Settings → Workers**, enter only a device name and a reachable HTTPS control
URL, then click **Enroll worker**. Enrollment copies a private setup prompt and shows
**Paste to agent**. Paste it into a coding agent on the new device. The prompt
contains that worker's scoped credential; a Markdown download is also available. It handles the terminal setup and walks you through any
interactive provider and website login. The guide covers cloning
this repository's `main` branch, Node/pnpm, credential storage, model-free
connectivity checks, provider authentication, optional browser capability, startup
and Online verification. Headless Pi workers can run agents without an extension.
Keep the prompt or downloaded file private and out of git. If clipboard access is
blocked, use Copy setup or the selectable text without enrolling again.

The control URL must be reachable from that new machine: localhost points to the
worker itself, not your Mac. Worker machines do not run `pnpm dev` or need direct
database access. The legacy JSON enrollment response remains available to CLI/API
clients; the Settings UI requests the Markdown download.

Choose the default agent and its model in **Settings → Default agent and model**.
Each agent remembers its own default model. New conversations inherit these
settings; existing conversations keep their selection. The composer lets you
choose a different model and change it during a session. Changes apply to newly
submitted messages; queued/running messages retain their accepted model. Native
conversation identity is preserved. Changing Claude/Codex requires a new session.
Use **Custom model…** for an exact ID supported by your account, or **Provider
default** to use the worker/provider configuration.

Attach PDFs and other files with the paperclip, drag/drop, or paste. The picker
retains its selection until submission and can select the same file again. Images
become native image input; PDFs and other documents are delivered as tool-readable
files. File delivery does not guarantee that every model/runtime can extract a
particular PDF. Limits are eight files, 10 MiB per file and 5 MiB per image.

## Integration tool collections

Open **Settings → Integrations → Add MCP server** to discover a reachable HTTP
MCP tool collection, then review and save the tools each workspace may use.
Connections grant nothing until bound. The same registry and gateway support
native API adapters. Credentials use existing server-side secret references;
changing a connection or tool schema requires reviewing workspace access again.
Calls run on demand in the control process; native Claude/Codex loops and workers
receive only the existing scoped harness gateway. No extra daemon starts.
See [supported MCP transport, authentication and fixture verification](docs/mcp-connections-plan.md#shipped-http-slice-2026-10-23).

## Persistence and recovery

Without `DATABASE_URL`, the launcher puts application state in `.data/harness.sqlite` and Workflow state
in `.data/workflow`. Set `HARNESS_DATA_DIR` to an absolute directory to relocate
both. Provider-native transcripts remain in their normal CLI-managed stores;
copying `.data` alone is **not** a portable provider checkpoint.

- Turn submission uses a stable client-generated ID; conflicting reuse is rejected.
- A pending turn is the dispatch outbox. The web process retries undispatched
  records every five seconds locally, or through hosted request/cron reconciliation.
  Completion uses durable per-run hooks rather than workflow polling. Dispatch is at least once;
  enqueue and worker claims are idempotent, so duplicate orchestration runs cannot
  execute the same turn twice.
- At most one active turn can mutate a session. Multiple workers sharing this
  local database claim turns atomically.
- A worker renews a 3-minute ownership lease every 5 seconds and keeps retrying
  its requests for up to 150 seconds, so a control restart or an overloaded
  control host does not kill a running agent. After expiry, the next claim scan
  marks the turn interrupted and fences its writes. Interrupted agent turns are
  never retried automatically: inspect partial results and submit a new instruction.
- A graceful shutdown terminates the current provider process and records an
  interruption. A hard kill is detected after lease expiry when a worker runs again.

The control plane owns application persistence (local SQLite or Prisma/PostgreSQL).
Workers communicate through authenticated HTTP
and can run on separate machines without sharing database files. The default
launcher binds to `0.0.0.0`; Next.js and internal callbacks remain on loopback.
A local filesystem still is not Vercel-hosted
persistence.
The local Workflow world is a development backend; production durability requires
the hosted world or another supported persistent backend. Browser takeover,
attachments, schedules, Telegram and optional cold capacity now have implementations.
Selective memory audiences, a publication/artifact service and Codex native
cross-host export remain future work; Claude SDK transfer stays behind its
compatibility gate. Actual Pi/Sandbox/public deployment still needs validation.

## Shared decisions

Every turn, including a resumed Claude/Codex conversation, receives the latest
shared decisions in its prompt automatically. The agent should answer relevant
questions from these records without a reminder to search. Open **/knowledge**
or **Shared decisions** in the sidebar to see canonical content, revisions, and
source conversations. A successful publication also appears below the agent's
response; the agent's prose alone is not proof that knowledge was published.

Try: tell Tech **“Business pilot price is $173”**, then ask a new Business session
**“what was the pilot price”**. Change it to $219 in Tech and ask that same Business
session again. It should use the latest record and cite its key/revision.

The worker materializes the full snapshot as `SHARED_DECISIONS.md` and puts an
index in the prompt: each key, revision and first line, this workspace's records
first, within about 8,000 characters. Agents read the full text of relevant
records from that file or with `memory_get` (by keys or a search query). Agents publish structured updates through `DECISION_UPDATES.json`;
they receive these instructions automatically. A private `DECISIONS.md` remains
session-local. Updates commit atomically with successful turn completion, require
the consumed expected revision and current ownership, and keep revision history
and workspace/session/turn provenance. Conflicts fail visibly for review rather
than overwriting another session's update. Invalid/failed updates stay local and
are preserved before the next turn resets the publication file.

This first collection is explicitly shared across all workspaces belonging to
this personal harness. Selective audiences, git-backed canonical sources, search,
and invalidation during an already-running turn are not implemented. Freshness
is enforced at turn start, not at every native tool call. The store holds up to
500 records; publication past that fails rather than silently dropping records.
Keep secrets in provider/credential stores, outside shared decisions.

```sh
# No model calls; real HTTP workers and subprocess fixtures for both flavors:
pnpm bench:knowledge
pnpm bench:knowledge --provider=claude
# Explicit opt-in: five real provider turns in a disposable database:
pnpm bench:knowledge --live
pnpm bench:knowledge --live --provider=claude
```

The bench verifies publication, cross-workspace proactive recall, updates in an
existing conversation, and control/worker restart. It does not change your actual
decision collection or existing sessions.

## Daily briefs

**Home** shows each workspace's latest daily brief: a headline and a few
highlights, opening into a short visual page with diagrams. Earlier days stay
available from the day strip, as a changelog.

Each morning after 05:00 in the owner's time zone (`HARNESS_TIMEZONE`, else the
control host's), control checks the previous day. A day with no completed turns
is skipped without running an agent. Otherwise the **Daily briefs** session (in
its own workspace, with the default agent) gets a digest of that day: each
workspace's sessions, what was asked and the outcome, decisions published, and
the previous brief. It publishes one brief per workspace with `brief_publish`
and may read more with `session_read` or `decision_source`. **Write now** or
**Rewrite** on Home runs it by hand for the day shown.

Briefs are stored in the database (`briefs`, one per workspace and day) and
outlive the session that wrote them; deleting a workspace deletes its briefs.
Every session can read them with `brief_list` and `brief_get`, for example to
draft an investor update. Agent-written HTML is sanitized (no scripts, forms or
remote loads) and rendered in a shadow root with a small stylesheet built from
the app's theme (`apps/web/lib/brief-kit.ts`), so briefs match the app in light
and dark mode.

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
demonstrate this. Application output/errors are in application storage; orchestration events
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


## Tasks, capacity, and the failure bench

A task owns an objective, priority, resource profile, and conversation. Every new
message remains a separate turn. Pausing a task prevents new work from starting;
active work finishes. Draining a worker prevents it from claiming more turns.
Selecting a target worker applies to subsequent claims; it does not move a live
process. An unschedulable heavy task does not block eligible lighter tasks.

Resource profiles reserve estimated memory and CPU capacity. Admission also
checks reported free host memory, a headroom reserve, load per CPU, provider
availability, and separate build/browser slots. These are admission controls,
not OS-enforced limits. A task can use more than its estimate. Free memory is a
conservative OS measurement (cache reclaim and memory pressure vary by OS).
All settings apply to this harness worker; unrelated processes are unaffected.

Chat conversations also appear on the task board after their first instruction;
existing conversations are added automatically without changing their turns.
Queued messages show the actual admission reason in chat, including offline
workers, provider cooldowns, occupied slots, and measured memory headroom.

Host memory admission uses Linux `MemAvailable`. On macOS it estimates available
memory from free and inactive pages while memory pressure is normal or warning;
warning alone does not block work. Critical pressure blocks new native agents.
Failed OS probes fall back to
free memory. Samples are cached for five seconds. Demo starts no agent process
and ignores host pressure/load flags, but still obeys reservations and headroom.
These measurements remain estimates, not a guarantee of future allocation success.

The Demo runtime checkpoints between three deterministic steps. Its files and
output checkpoint together at the control plane. If a worker disappears, the
3-minute lease expires and another eligible worker restores that checkpoint.
Demo is explicitly safe to replay. Native Claude/Codex turns remain interrupted
after worker loss. A CLI conversation prefers the worker that ran it last, but
any eligible worker continues it when that one is off, draining or busy for two
minutes: the new agent starts fresh with the conversation so far (prompts and
replies from the control plane) instead of its native memory. Completed Claude
SDK checkpoints move with their memory under the separate gate below. Sessions
can require worker labels (Advanced in the chat; labels per machine in
Settings); see `docs/architecture.md`.
They do not have the same recovery guarantees as Demo.

```sh
pnpm build
pnpm bench
```

The bench starts an isolated control plane and two separately enrolled worker
processes with independent local directories. It uses no models and does not
exhaust real memory. It checks heavy/light admission, abrupt worker loss,
checkpoint/file restoration, stale-generation rejection, draining, continuation,
duplicate submission, and credential isolation. Expect about 40 seconds, mostly
the real lease expiry. It cleans up its processes and temporary credentials and
writes a non-secret result summary to `.data/bench/latest.json`.

## Connect a remote worker

Run the control plane independently of the Mac before expecting work to survive
closing the Mac. On the control host:

```sh
pnpm build
pnpm start:control
# In another shell, enroll an identity (the token is written to a 0600 file):
pnpm worker:enroll --name pi --url https://your-control-host --out /secure/path/pi.json
```

Copy that credential file securely to the worker host, install this repository
with Node 24/pnpm, and run:

```sh
pnpm install --frozen-lockfile
pnpm worker --credential /secure/path/pi.json
```

The credential contains the control URL. `HARNESS_CONTROL_URL` can override it.
Set `HARNESS_WORKER_DATA_DIR` for the worker's local execution cache. Remote
workers require HTTPS; `HARNESS_ALLOW_INSECURE_HTTP=1` is an explicit override
for a trusted private transport. Revoke a worker with
`pnpm worker:enroll --revoke <worker-id>` on the control host.

The launcher defaults to `HARNESS_BIND_HOST=0.0.0.0` for private-network access.
Override it to select a specific interface, and terminate HTTPS with a tailnet
proxy. Network binding enables administrator
authentication automatically and starts an allowlisted gateway in the launcher
process. Next.js and internal Workflow callbacks remain on a separate loopback
port. Development forwards same-origin Next.js HMR through the gateway; production
rejects HMR upgrades. Use `pnpm dev` for editing and `pnpm start` for everyday
private-network use with lower memory usage. The login page
uses Google or the configured hosted identity provider; it never asks users to
paste an administrator token. Until Google is configured, it shows a disabled
Google button and an explicit setup-pending message. Existing local administrator
credentials remain available to legacy automation and isolated test fixtures;
the launcher keeps `<HARNESS_DATA_DIR>/admin-token` private. Selecting Google mode
disables that legacy owner access. Worker credentials are separate and cannot
administer tasks. Explicit loopback-only development needs no login unless
authentication is configured.

For a short walkthrough, see [Google login credentials](docs/google-login-setup.md).

For Google owner login, set `HARNESS_AUTH=google`, `HARNESS_PUBLIC_URL`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET` (32+ random
characters), and `HARNESS_OWNER_EMAILS` to the allowed verified Google email(s).
The login page shows **Continue with Google**. Other accounts and unverified email
claims are denied; legacy access-token login is disabled in this mode. It works
with local SQLite on the Pi as well as PostgreSQL and needs no additional service.
Register `<HARNESS_PUBLIC_URL>/api/auth/callback/google` in Google Cloud Console.
Use HTTPS outside localhost. Google mode keeps an allowlisted gateway even behind
a loopback reverse proxy, so internal Workflow routes stay private.

See [Pi, Headscale, HTTPS and Google setup](deploy/pi-headscale.md) for DNS, OAuth
configuration, a data-preserving move from this Mac, systemd startup and worker
reconnection. MagicDNS resolves names; HTTPS certificates are configured separately.

This is a trusted-worker prototype, not a multi-tenant sandbox: native tools run
as the worker's OS user. Worker secrets are omitted from provider subprocess
environment variables, but same-user filesystem access is not an isolation
boundary. Keep enrollment files outside execution directories, and isolate
provider processes before exposing untrusted workloads.

## Experimental native Claude continuity

Set `HARNESS_CLAUDE_RUNTIME=sdk` on participating workers to use the pinned Claude
Agent SDK with an external native-transcript store. The default stays on Claude
CLI while this compatibility gate is open. The SDK is loaded only for active
Claude turns. `HARNESS_CLAUDE_MODEL`, `HARNESS_CLAUDE_MAX_BUDGET_USD`, and
`HARNESS_CLAUDE_TOOLS=none` are optional per-worker settings.

Native entries are opaque, ordered, deduplicated by UUID, and scoped to the
assigned harness session. The adapter maps provider project keys to a stable
harness namespace while leaving the worker's auth directory unchanged. After a
successful turn, transcript revision and execution-file checkpoint must agree
before another SDK-capable worker may continue. A failed mirror or newer partial
transcript prevents relocation. Mid-turn native interruptions still require
reconciliation; they do not automatically replay.

```sh
pnpm build
pnpm bench:claude
```

This explicit opt-in bench attempts two small real Claude turns, disables tools,
and sets a $0.10 SDK budget per turn. It checks native ID continuity, recalled
context, and an execution file across two worker directories. Unlike `pnpm bench`,
it requires provider authentication and available quota. The live attempt on
2026-10-17 was blocked by the account's session limit, so actual native transfer
remains **unverified**. Unit tests cover the adapter and isolation/revision rules.

Structured Claude usage-limit events also place that worker/provider into a
cooldown until its reported reset (five minutes if no reset was supplied).
Queued tasks for other providers can continue. A turn that already encountered
the limit remains failed for explicit follow-up; it is not silently rerun.


Run `pnpm test:security` after a build to exercise the authenticated network gateway.
See [private deployment preparation](deploy/README.md) for Linux service templates
and the remaining real-hardware acceptance gates.

### Managed browser and live view

Workers use a dedicated persistent Patchright profile by default, independent of
personal Chrome. Run `pnpm browser:install` on supported hosts, or configure a
compatible system Chromium with `HARNESS_BROWSER_EXECUTABLE` (for example,
`/usr/bin/chromium` on the tested Pi). Use `HARNESS_BROWSER_BACKEND=managed` when
upgrading a worker previously configured for the extension. No extension pairing
or remote-debugging permission dialog is part of this flow.

Open a conversation's browser to watch without taking control. The existing
launcher relays an encrypted CDP screencast over a persistent WebSocket; frames
and interactive input do not go through the database command queue. Click Take
control or Sign in, then click/type/paste directly in the live page. Esc releases
control without submitting a message. Continue task explicitly resumes a login
wait. Closing a read-only view also sends no message.

Each host keeps its own browser login state. A different host may need manual
login/MFA through takeover; personal Chrome credentials are not copied. Agent
browser actions retain bounded step summaries and screenshots, excluding manual
login input and frames. Browser processes start on demand and close after idle.

Browser reads now include accessibility information with form values omitted.
For Sheets CRM work, `browser_action` supports `sheet_read` with a `gid` and bounded
rows/columns, using the signed-in document's HTML view. Opening an editor alone is
not evidence that its cells were read.

The agreed next step is a host-independent browser-resource model: compatible
workers on the Mac, Pi or Sandbox may host browsers independently of agent
execution. Dedicated managed browsers use Patchright behind the same gateway. Explicit resource bindings and placement are planned;
see [Browser resources across workers](docs/browser-connection-options.md).

## Google Workspace read tools

Settings → Integrations supports separate Google account connections and explicit
workspace tool grants for Gmail, Drive, Docs, Sheets and Calendar events. The
existing control/API process performs bounded reads through the common harness MCP
gateway; Claude/Codex retain their native loops. Owner sign-in grants no Google
data scopes. Configure separate resource OAuth and encrypted refresh-token storage
using [Google integration operations](docs/google-integrations.md). Drafts, edits and
sending remain unavailable; fixture tests need no real Google account or model.
