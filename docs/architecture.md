# Architecture and the Eve reference

The delivery state and remaining external gates are in
[implementation-checklist.md](implementation-checklist.md); configuration and
reproduction commands are in [operations.md](operations.md). Decision: Vercel
Workflow is the initial engine. The Pi is the first control-plane deployment
target, reached privately through Tailscale; hosting the UI/API on Vercel is optional. Eve is an architectural reference, not a runtime
dependency. Temporal remains a future composition adapter.

## Transport, application and execution

```mermaid
flowchart LR
  UI[Phone / desktop UI] --> API[Owner-authenticated API]
  TG[Telegram / Chat SDK] --> IN[Verified durable inbox]
  IN --> API
  API --> DB[(Async application storage)]
  API --> WF[Workflow composition]
  WF --> FN[Ordinary application functions]
  FN --> DB
  DB --> W[Outbound worker / ownership lease]
  W --> RT[Claude / Codex adapters]
  RT --> MCP[Attempt-scoped MCP gateway]
  MCP --> BR[Independent browser host]
  W --> OBJ[Private object port]
  DB --> OUT[Notifications / durable wakeups]
```

`packages/core` contains JSON domain values, pure admission/cron rules and execution
ports. It imports no Node, storage, provider or engine SDK. `packages/storage`
implements async transactions for local SQLite and Prisma/PostgreSQL. Checkpoint,
object and runtime functions have no Workflow directives or SDK context. Only
`apps/web` composes Workflow steps/timers/hooks and Chat SDK/Sandbox adapters. The
worker runs native provider execution outside an engine step, so engine retries
cannot implicitly repeat an agent's external effects.

[Eve's architecture](https://github.com/vercel/eve/blob/main/packages/eve/README.md#architecture-internals)
separates channels, harness execution and durable orchestration. We retain that
separation and the independent lifetimes of conversations and compute. A session
is a durable record, not a warm process. Eve owns a model/tool loop; our native
Claude/Codex process owns its loop, so an engine cannot replay it instruction by
instruction. Its [decoupling proposal](https://github.com/vercel/eve/issues/512)
is useful design context, not a runtime contract copied into this codebase.

## Durable input, ownership and outcomes

A workspace owns instructions and resource policy. A session owns its provider,
native lineage, conversation, read cursor and checkpoint reference. A turn owns
one submitted instruction. Multiple pending inputs are allowed, with a 100-message
waiting limit and exactly one running turn per session. Claims exclude earlier
pending/queued inputs, even if engine dispatch happens out of order. Waiting
messages hold no agent processes or machine reservations.

Accepted input and its pending dispatch state commit together under a stable client
ID. The dispatcher may start duplicate engine runs after an acknowledgement loss.
Each run registers its own completion waiter, but enqueue/claim execute the same
application turn only once. Workflow history contains IDs and small status values,
not transcripts, files, raw credentials or browser state. A Workflow run per turn
bounds engine history and lets subsequent turns use a newer deployment without
changing application session identity.

The worker acquires an increasing generation, materializes its execution directory
and checkpoint, streams ordered events, heartbeats, and checkpoints progress.
Worker capacity reports are distinct from active-turn heartbeats. Both have
bounded timeouts; a missing heartbeat fences old writes and gateway admissions.
Only Demo work is replay-safe and automatically recovers from its checkpoint.
Interrupted native execution becomes interrupted and needs explicit continuation;
its original external effects may already have happened.

Completion persists result/checkpoint before acknowledgement. A repeated completion
returns the stored outcome. Terminal transactions also record unread attention,
notification outbox entries and durable engine wakeups through equivalent SQLite
and PostgreSQL triggers. Wakeups resume per-run hooks rather than polling Workflow
steps every five seconds. If completion wins the race with waiter registration,
the later workflow reads an already-terminal record and exits without waiting.
Local development reconciles through one unreferenced timer in the existing web
process; hosted functions use request `after()` plus authenticated cron repair.

Worker RPC uses the static `/api/worker?action=...` route, with the same scoped
credential and assignment checks for JSON, file reads and encrypted uploads.
The former `/api/worker/[action]` endpoint remains compatible with older workers.
Next dev runs static-path discovery for dynamic routes, even for these POSTs;
using the dynamic endpoint for frequent polls started repeated analysis processes.
Restart upgraded workers to move their traffic to the static endpoint. This does
not change the Workflow engine or its protected internal routes.

Stopping pending/queued input is immediate. Running work stays Stopping until its
worker acknowledges or loses its lease. Stop racing completion wins and prevents
decision publication; it cannot retract an in-flight website request. Interrupt and
send records the stop and follow-up together. The follow-up waits for the earlier
execution to release ownership. No implicit native steering/resume is assumed.

## Persistence and portability

`SqlDatabase` is an async, bound-parameter transaction port. SQLite remains an
optional lightweight local adapter; an async per-file gate avoids blocking the
Node event loop between independent connections. PostgreSQL uses Prisma's `pg`
adapter, a three-connection pool and serializable transactions with bounded conflict
retries. Application SQL is fixed code; values remain bound. The adapter handles
identifier quoting, SQLite's scalar MAX and binary-length expressions explicitly.
Schema migrations preserve partial uniqueness, queue indexes and atomic attention.
Supabase is a deployment host only: no Supabase SDK/Auth/Realtime/extension coupling.

A read-only SQLite export and fresh-database PostgreSQL import preserve identifiers,
ordering, revisions and sequence positions. Import refuses populated tables and
verifies all content before commit. Object files and encryption keys are separate
recovery inputs. Real backup retention, off-device recovery and release rollback
procedures must be tested on the chosen infrastructure.

File checkpoints are bounded manifests with hashes and attachment references;
attachments remain in the object port rather than inflating every checkpoint.
Current limits are 512 checkpoint files / 4 MiB file content and 16 MiB of mirrored
Claude native entries per session. These are prototype data limits, not limits on
other applications. Default CLI state remains on its provider's local store.
Codex cross-host native export is still unimplemented; same-host continuation is
supported. A native ID alone never restores another host's files/authentication.

Large transport messages are encrypted authenticated payloads in the private object
port, with short-lived grants bound to worker/turn/generation/purpose. Payloads over
1 MiB use direct object upload/download on S3-compatible storage, so native images
and checkpoints do not exceed hosted function body/response limits. Encryption keys
travel only over the authenticated worker channel and are not stored beside the
objects or in Workflow history. The object payload is temporary transport; the
committed application/native records remain canonical. Local objects provide the
same flow for fixtures. Transfers are bounded at 64 MiB, checksummed, authenticated
before decoding and revalidated against current ownership. Configure temporary-
object lifecycle cleanup separately from durable attachment retention.

## Native runtimes and credentials

The default adapters start CLI processes on demand and exit after a turn. Codex
uses `exec`/`exec resume` with ignored user configuration. Claude uses
print/resume and explicit MCP configuration. Agents run with full permissions by
default (the owner runs their own sessions that way); a sandboxed session (or a
worker with `HARNESS_AGENT_PERMISSIONS=sandboxed`, or an isolated Linux worker)
uses Codex workspace-write and Claude `dontAsk` with narrow file publication
permissions. The native cwd stays the session's scratch directory, because Claude
keys its memory by directory; a workspace folder (`workspaces.folder`, `~/`
resolved per machine) is added with `--add-dir`/`additionalDirectories`, its
CLAUDE.md is loaded, and the agent is told to work there or that the folder is
missing on this machine. Unsupported permission prompts are denied; durable input
questions use the harness MCP tool and finish the native process instead of
keeping it alive indefinitely. CLI environment filtering omits control-plane,
Telegram and cloud-administration secrets. Claude API-only bare mode is opt-in;
its default path retains account login support.

The opt-in Claude SDK adapter implements the engine-independent
`NativeSessionStore` append/load/subkey port with a stable harness project namespace.
Native entries are ordered, UUID-deduplicated and checked against the assigned
session. A durable file checkpoint records its matching native revision; a newer
partial transcript invalidates that checkpoint for relocation. Actual provider
entitlement, authentication renewal, ARM64 behavior and real-host transfer remain
provider-specific gates. Cross-provider conversion is a handoff, not lossless
native continuation. No entire provider auth directory is copied into checkpoints.

Owner authentication, worker enrollment, attempt tool grants and browser control
leases are separate identities. Hosted owner access uses OIDC/PKCE and a subject or
verified-email allowlist, with hashed expiring revocable sessions. Missing settings
fail closed. The private launcher hides internal engine routes; on Vercel the
Workflow build integration preserves queue-consumer protection. A deployed app
must verify that protection and its production authentication before real access.

Secret policies name references and environment bindings. A backend port resolves
only currently granted references, audits issuance without values, and rechecks
ownership/policy before delivery. The initial backend maps to deployment secret
variables; another engine can replace it without changing runtime contracts.
Known secrets are redacted across output chunk boundaries and mirrored strings;
file checkpoints reject known granted secret bytes. These controls do not make a
secret invisible to a process that is authorized to use it, nor prevent deliberate
encoding/exfiltration. Revocation affects future fetches; an existing process must
be stopped and the underlying credential revoked when necessary.

The ordinary Mac worker is a trusted same-user process. An optional Linux supervisor
container drops each native session to a separate UID/private home and keeps its
own credential outside those permissions. Environment filtering alone is not
filesystem isolation. Real provider binaries and the deployed container still
need an isolation/security validation; this is not a multi-tenant security claim.

## Memory, artifacts and fresh context

Shared accepted decisions use revisioned history with withdrawals. Each turn
receives an index of the current snapshot in context (key, revision and first
line; this workspace first; about 8,000 characters) and the full snapshot as a
local file, including cross-workspace findings; models need not discover a
hidden DECISIONS.md in another session. They read full records from that file or
with `memory_get` (keys or a query). A turn records only the snapshot revision it
read; history is append-only, so that snapshot is rebuilt exactly for retries and
for checking its updates' expected revisions. Publication uses expected revisions
and transactional receipts so a stale update cannot silently replace a newer
decision. The store holds up to 500 records of at most 4,000 characters each.

This remains an application-canonical decision service, not the future git-backed
knowledge repository. Selective audiences, git/skill ingestion, retrieval indexes,
subscriptions and enforcement at every model/tool boundary remain separate work.
The system does not claim to identify every stale belief inside a model. Existing
Litho/vault/provider-session migration stays deferred.

Attachments are immutable scoped records with durable object references, binary
hashes and upload receipts. UI paste/drop/picker share the same flow. Workers
materialize both current and earlier session attachments on relocation, and only
current image attachments become new native multimodal input. Other formats are
explicit file paths, not presumed model-native formats. Credentials, execution
homes and attachment byte copies are excluded from portable file manifests.

Agent defaults are application settings stored through the repository port.
They select the agent and a separate preferred model for each provider, and seed
new sessions only. Session model changes retain provider/native IDs. Turn creation
atomically snapshots the session's model; execution overrides the session view
with that snapshot, so later changes cannot affect waiting/running turns. A null
model delegates to the worker/provider default. Model IDs are data passed as
individual SDK/CLI arguments, never shell command fragments. Workflow carries no
provider-specific selection logic. Both SQLite upgrades and Prisma migration 10
add nullable model columns without rewriting native checkpoints.

File-picker and drag/paste handlers snapshot browser file lists synchronously.
Clearing an input or leaving a drop event can invalidate its live FileList before
a deferred React update reads it. Upload receipts and worker binary integrity
checks remain unchanged; PDFs use the existing generic document file path.

## Scheduling, attention and channels

Cron calculation is engine-independent and stores an IANA timezone. Natural-language
requests become inactive agent proposals with the exact prompt and destination;
the owner reviews the exact revision, edits it, or approves activation. A revisioned
Workflow timer sends an occurrence into the normal session input queue. The default
destination is the creating conversation; the UI can select another existing or
one dedicated persistent conversation. A new session is not created per occurrence.
Missed and overlapping recurring reviews coalesce, old timers are invalidated, and
one-time reminders post text without an agent worker.

Terminal attention has monotonic read sequences. Clients clear only the snapshot
they actually displayed and cannot clear a newer result accidentally. Input/login/
schedule review requests add a needs-input state. Unread/needs-input sessions sort
first and collapsed workspaces aggregate their badges. Manual pencil titles are
separate from asynchronous cheap utility naming, so automatic naming cannot
overwrite a manual choice. No title operation starts a full agent process.
Native agents also receive a session-scoped `session_title` tool and the current
title/source. They can refine generated titles in the existing turn without a
separate model call; a conditional update always preserves manual titles. The
offline fallback selects bounded topic words; configured cheap utility naming
remains independent and optional.

Owner decision edits and deletions use expected revisions and append to accepted
history. Deletion is a null-content withdrawal, which still invalidates old
conversation beliefs. Earlier source links remain in history; the owner-created
revision retains workspace provenance without attributing it to an agent turn.
Restoration appends another revision. No physical history purge is exposed.

The Codex adapter explicitly approves tools on its attempt-scoped harness MCP
server. This is separate from CLI `approval_policy=never`, which otherwise rejects
MCP calls needing a prompt. It changes no global CLI configuration or shell
sandbox permissions. The gateway still validates ownership, workspace policy and
tool arguments, and schedule activation remains available only through owner
review. Claude retains its existing narrowly scoped MCP allow rule.

Telegram uses the official Chat SDK adapter and PostgreSQL state without Redis.
Ingress verifies the webhook and owner/chat allowlists, commits a durable inbox
before acknowledgement, then hands the update to the adapter. Application input
handling and its inbox receipt share a transaction, avoiding the adapter's early
update-ID acknowledgement gap. Replies use the same persistent session input path;
`/stop` uses its control path. Session-to-topic mappings are durable. A small native
bridge creates/renames topics; ambiguous creation waits for inspection rather than
creating another topic automatically. Notification delivery is a separate outbox
with retries/receipts and authenticated UI links, and does not mark a session read.

## Where a conversation runs

Workers offer labels, like Kubernetes node labels: the agents they run
(`codex`, `claude`), `browser` when they host one, `HARNESS_WORKER_LABELS`
(default: CPU architecture), and labels the owner adds in Settings (stored on
the worker row, for example `asap7` for a machine with chip tools). A session
may require labels (Advanced in the chat; `sessions.requiredLabels`); only
workers that have all of them claim its turns, and the waiting reason names
the missing label. Schedules keep their own optional target worker.

Without labels any machine can continue any conversation, so work does not
depend on one machine staying on. Native Claude Code and Codex memory lives on
the machine that ran the session (`ownerWorkerId`). That machine is preferred
while it is online and free, and for two minutes while it is busy. Otherwise
another eligible worker claims the turn; the claim clears the native ID and
checkpoint, and the claim route prepends the conversation so far (earlier
prompts and replies, newest kept within about 60k characters) to the prompt.
That worker becomes the new home. Files, clones and uncommitted work stay on
the old machine, and the agent is told so. A complete Claude SDK checkpoint
still moves with its memory. Interrupted native turns are never retried.

Agents can move themselves between steps. `machines_list` shows the machines,
their labels and whether they are online. `continue_on(labels, message, reason)`
queues the agent's next step in the same session with per-step labels
(`turns.requiredLabels`, combined with the session's), for example to verify on
the machine with the chip tools after coding elsewhere, and back to any machine
afterwards. The reason is stored (`turns.placementReason`) and shown in the
chat, which also marks a step that ran on a different machine than the one
before. Agents are told to push before moving. At most five self-queued steps
run in a row without an outside message. On a task from another session the
report waits for the last step.

Sessions coordinate with notes (`session_note`): a message to another session
that is not a task, for example two workers agreeing an interface. It arrives
as a "Note from" turn (`session_notes` links it), may be answered with another
note, and does not wake the planning session, which sees recent notes in
`task_list`. Two sessions exchange at most 20 notes an hour. A note that
unblocks the recipient's open task links to it when the agent reports, so the
report reaches the planner. Planners give each new task a short title.

## Sessions handing work to sessions

A planning session can hand work to the owner's other sessions with
`session_send` (any workspace, any agent: a Claude planner can drive Codex
workers). The message becomes an ordinary queued turn in the worker session,
linked to a `delegations` row; feedback and answers on the same task are more
turns on that row (`delegation_turns`, one round each, at most six). When a
linked worker turn ends, maintenance posts one report turn into the sender:
the worker's `task_report` (done, question or blocked), its pending question to
the owner, or its final message as a fallback. That turn wakes the sender's
agent, which reviews it and replies on the task, closes it with `task_close`,
or hands out more work. Progress reports are stored without waking anyone.

The protocol text is added when a worker claims the turn, so stored messages
stay what the sender wrote and workers need no update. Worker turns are told to
keep moving and to put any question, including one only the owner can answer
(purchases, deletions and other sensitive or irreversible actions), in a
`task_report` question; the planner answers it or asks the owner.

Only the planner notifies the owner. A worker's task, feedback and continuation
turns, notes, and a worker's questions are delivered in the app only. A
planner's turn that handles a report notifies when it asks the owner something
(`request_input`) or calls `notify_owner` with a one-line message, which becomes
the push text. Turns the owner starts, in any session, notify as before. A turn working on a task cannot hand work onward; agents
use their own subagents for parallel work. The owner sees each task, its state
and latest progress and report in the session, and can cancel it. This is the
in-harness form of the inter-harness message model (request, report, question,
answer, with who decided what), without the permission filtering that a
different owner's harness would need.

## Browser identity and optional capacity

### Agreed target: browser resources on any eligible worker

Browsers are worker resources with placement independent of agent execution. A Mac,
Pi, other compatible machine or provisioned Sandbox can host a browser resource;
any authorized agent can use it through the browser gateway. A worker can host only
browsers, only agents or both. Advertise browser/runtime capabilities, architecture,
health, memory/CPU/browser-slot budgets and resource lifetime. Placement selects a
resource satisfying the requested identity, authorization and task requirements.

A browser identity records the authorized account/profile and supported durable
state; its current host is a placement detail. A lease fences control and assigns
session-owned tabs. Host-independent adapters use Patchright to connect through a
paired extension/local relay or supervise a managed browser. Screenshots, encrypted
manual takeover, resource policy and the operation ledger share the gateway path.
Extension support is validated per host; managed headless browsers can satisfy
resource requests on compatible Pi/Sandbox runtimes without a desktop extension.

An offline host affects resources bound there. Other eligible resources remain
usable. Failover requires the requested identity to exist or supported state to be
restored and validated; otherwise pause the dependent task. Ephemeral browser
resources publish their lifetime and persist checkpoints/artifacts/supported state
externally. Browser allocation and idle cleanup are independent of agent slots.
Unknown external outcomes and interrupted native execution are not replayed merely
because a different resource becomes available.

This target is documented in [Browser resources across workers](browser-connection-options.md).
Explicit resource registration/bindings and full identity-specific placement remain
implementation work. Browser allocation now prefers the executing worker when an
existing browser is idle, without a global personal-Chrome preference. Active
commands, running turns using that browser and human takeover retain their host;
offline/disconnected hosts cannot pin a workspace indefinitely.

### Initial deployment login policy (2026-10-23)

No browser task should require the Mac to remain online. Each eligible host keeps
its own persistent browser login state. When the selected host is signed out,
request interactive takeover for password/MFA entry on that host, including the
Pi. Reuse valid sessions rather than asking on every task. Do not copy personal
Chrome credentials or require an unlocked password vault. Password-manager
automation is deferred; an optional future 1Password integration adds no current
subscription requirement. Host relocation may require a new login and must still
respect native interruption and unknown-outcome safeguards. This is the agreed
policy. Broker host-loss and headless takeover are covered with fixtures; actual
Pi account login remains a real-host validation gate.

### Current implementation

A workspace browser identity has one host lease and ownership generation. New
allocations prefer the agent's worker when eligible, while a healthy active
browser/human takeover retains its host. Managed Patchright profiles are the
normal path on every platform. The broker excludes extension/personal-Chrome
backends from new placement. Existing extension source and pairing files are
retained for compatibility, not used by the new UI or enrollment guide.

The managed browser is a separate persistent profile, headless by default, with
on-demand startup and idle cleanup. Supported Linux hosts may use a compatible
system Chromium through HARNESS_BROWSER_EXECUTABLE. A slow startup counts as an
active allocation, concurrent opens share the same launch, and a fresh starting
lease has a bounded grace period before unused release. This prevents the Pi
poller releasing a browser while its stream is still launching.

Browser tools still use the durable command/operation ledger. The live owner view
uses a separate ephemeral path: CDP screencast -> authenticated outbound worker
WebSocket -> relay in the existing control launcher -> owner browser. No new
resident daemon or public CDP port is introduced. Frames and direct interaction
never pass through the SQL command queue. JPEG frames are change-driven, throttled
and dropped under backpressure rather than accumulated. A closed view stops its
screencast; the managed browser then follows the normal idle policy.

The owner may watch without taking control, and close without sending a message.
Take control/Sign in establishes an exclusive generation-fenced manual lease;
normal pointer, keyboard and paste events go directly over the stream. Esc
releases control without a turn. Only explicit Continue task submits a continuation.
Login waits remain pending on ordinary release. Each viewer creates ephemeral
ECDH keys, so the relay sees encrypted frame/input payloads. Owner auth/origin and
worker credentials are checked on upgrades; every input rechecks controller key,
generation, enrollment and lease. Streams are periodically revalidated and fail
closed on host loss/revocation. Human input/capture stay out of model history and
browser-action records. Browser interaction failures are never automatically
replayed.

The view identifies its host, connection state and input acknowledgement latency.
Agent actions have bounded step summaries and optional screenshots in the
conversation. Manual input is excluded and fill summaries omit values. Agent
result images retain the existing private command storage for up to 24 hours;
the UI fetches the latest 12 steps and uses a cursor to avoid repeatedly transferring
unchanged screenshots. This is recent activity, not an unbounded video recording.

Reads include bounded accessibility text with form values omitted. Sheets CRM
reads use authenticated htmlview/sheet content, parsed outside the page's Trusted
Types policy, with row/column/byte bounds. Network isolation still rejects private,
control-plane and credential-bearing destinations; the loopback exemption is only
for explicitly configured isolated acceptance fixtures.

Tool operations use stable logical IDs and a session-scoped ledger; old generations,
stopped turns and manual-control leases reject new agent admissions. Unfinished
operations are supplied to later turns and can be queried; unknown outcomes require
external reconciliation. Arbitrary websites do not provide exactly-once effects.

Browser hosts explicitly mark failures before action execution as `not_started`.
The tool handler persists those as failed and does not overwrite them in its catch
path. An explicit later tool call can retry the same logical operation ID with a
new physical command attempt; original failed commands remain in history. Worker
fencing, session scope and argument hashes still apply. This is not automatic
replay of an interrupted native agent. Errors after action execution starts stay
unknown unless there is a completion receipt. Legacy Chrome-connection failures
are reconciled only when the failed command contains the exact pre-execution
connection error; generic failures/timeouts are insufficient evidence.

The old encrypted queued-manual API remains for older clients and fixtures, but
is not the current live UI transport. Native provider interruption behavior and
external-effect reconciliation are unchanged. Browser supported-state backups
remain encrypted; profiles and authentication are host-local in the initial
policy. A new host may require manual login. Website/device-bound authentication
and real Google sign-in remain service-specific validation gates.

Sandbox is optional, cold and disabled by default. A workspace capacity policy plus
deployment configuration allow provisioning only compatible work. The manager
bounds vCPUs, concurrent jobs, rolling-day starts and lifetime, uses a prepared
pinned image, and enrolls an expiring identity scoped to one turn. Provider secrets
are fetched only for that owned turn. Browser-dependent/non-portable work waits;
finished/expired capacity revokes and stops. Actual cloud startup/auth/connectivity,
timeouts, spending and teardown must be validated before enabling real tasks.

## Google owner authentication

`HARNESS_AUTH=google` selects Better Auth independently of `HARNESS_HOSTED`.
The local Pi can retain SQLite; no additional DB connection or daemon is needed.
Google's authorization-code flow uses the configured canonical origin and exact
callback `/api/auth/callback/google`. Require a verified email from the explicit
owner allowlist at profile acceptance and on every protected request. Password
signup, account linking and direct client ID-token login are not exposed.

Better Auth validates encrypted eight-hour session cookies. The existing hashed
`owner_sessions` ledger makes revocation immediate across processes/restarts;
Google access/refresh tokens are not retained in an account cookie. Legacy token
login, owner bearer tokens and old owner cookies cannot bypass Google mode.
Worker keys and attempt-scoped tool identities keep their separate auth paths.

Only the required auth endpoints pass the public gateway. Google mode forces that
gateway even for a loopback listener behind Caddy; Next/Workflow callbacks remain
on a separate private port. Trust only the configured origin for browser writes.
The gateway replaces caller-supplied proxy IP headers before auth rate limiting.
Missing selected-mode settings fail closed. Google mode is enabled only after the
origin, provider client and owner allowlist have been configured. The public auth
status endpoint reports readiness without credentials or account information,
including while configuration is incomplete. The login page shows a Google setup
message instead of an administrator-token form; it does not change the selected
server access policy or silently enable anonymous access.

## Coding repositories and handoff (agreed follow-up)

Coding sessions bind repository URLs, isolated worktrees, branch/upstream,
base/head commit IDs and current PR URLs/numbers. A local commit is portable only
after pushing or bundling its git objects; the next host restores the exact
revision. An unconstrained pull can select a different revision.

Dirty state includes the index, unstaged changes and untracked files. Capture it
consistently with execution files and native provider state, or retain worker
affinity and pause if that host disappears. Record handoff readiness and uncertain
external effects. A clean tree does not imply that interrupted native execution
can be automatically retried. Begin with transfers at safe turn boundaries.

The session header should show linked repo/PR chips, branch, clean/dirty state and
current worker. Expand for commit IDs, per-repo details and handoff blockers. A
session may use multiple repositories and PRs. These are tracked implementation
requirements, not guarantees of the current generic file checkpoints.

## Temporal boundary

A Temporal adapter can compose the existing enqueue/outcome, schedule occurrence,
input, ownership and checkpoint functions through workflows/activities. It must
translate cancellation/timeouts, reconcile durable wakeups, drain existing runs
and preserve application session identity. Native execution retries remain disabled
unless its external effects and checkpoint semantics prove replay-safe. A new
import alone is not a migration. No second orchestrator currently owns a session.


## Deleting workspaces and sessions

Owner-confirmed deletion atomically removes dependent conversation records, tasks,
schedules, attachments, checkpoints, channel bindings and pending notifications.
Deleting a workspace cascades through all its sessions and its managed browser
identity. Removing the ownership records immediately rejects old worker actions;
active native processes abort on their next heartbeat. Deletion cannot retract
an external action already in flight.

A durable cleanup outbox cancels orchestration runs, removes object bytes and
stops associated Sandboxes outside the database transaction. Workers remove their
session directories/browser profiles once they reconnect and no affected agent
is executing. Offline worker caches are not remotely erased while unreachable.
Provider-managed CLI history, backups and messages already delivered to Telegram
are outside this deletion operation. Published shared decisions remain canonical;
source session/turn links are detached, and the workspace ID remains historical
provenance. A persistent bootstrap marker prevents deleted default workspaces
from being recreated after a restart.

## Browser account walls, activity and downloads

Known Google and LinkedIn sign-in walls return `needs_login` and create a durable
input request. They do not return page text/images to the agent or imply that CRM
or calendar data was checked. Google may reject an automated browser even when
manual control works; Patchright does not establish account compatibility.

Agent actions keep timestamped owner history with short action labels, target
URLs and post-action thumbnails (including reads). Read thumbnails are retained
for the UI without adding model vision input. Human frames and keystrokes remain
on the ephemeral encrypted stream; sign-in pages have no history thumbnail.

Managed browsers accept downloads into a private per-profile directory. Up to four
completed files of at most 8 MiB each are retained; transfers time out after one
minute. These are retention/retrieval limits, not a hard temporary disk quota while
Chromium receives a file. File contents are excluded from tool results, database
records and attachments. An owner with current manual control can retrieve a file
through authenticated, generation-checked encrypted stream requests in 64 KiB
chunks. A download is local to its browser worker, not automatically replicated.

Linux workers may enable `HARNESS_BROWSER_VIRTUAL_DISPLAY=1` with Xvfb and xauth
installed. Each active managed profile gets an authenticated private display and
headed Chromium. Display processes are created on demand and terminated with the
owned browser. This never attaches to the user's desktop or disables account
security. Headless mode remains the default elsewhere; a headed display is a
compatibility option, not a promise that Google permits automation.


Development routes only the same-origin `/_next/hmr` and
`/_next/webpack-hmr` WebSocket upgrades to the private Next server. The browser
stream relay still owns `/api/browser-stream`; unknown/internal upgrades are
rejected, and production never forwards HMR. Forwarded identity headers are
sanitized on both HTTP and HMR traffic, and gateway shutdown closes its tunnels.
Next's development client needs this connection to finish startup: dropping it
can leave login at its server-rendered loading state and trigger reload loops.

## Integration collections

The shared integration definition/connection/workspace-binding registry is
engine-independent. The authenticated harness gateway derives workspace identity
from the attempt grant, projects namespaced schemas/descriptions and invokes a
registered adapter on demand in the control/API process. Native adapters and MCP
HTTP collections share ownership, revision, explicit tool-subset and receipt
policy. Known pre-action rejection can be explicitly retried; ambiguous external
effects cannot. A physical attempt token fences receipt finalization. Active I/O
rechecks stop and revoked grants and conservatively records unknown outcomes.

The MCP HTTP adapter uses a cold bounded session with DNS-pinned destinations and
server-side secret references; its protocol/session state does not enter Workflow
history or native provider environment. Stdio/remote private-host execution,
upstream OAuth and durable protocol tasks remain later capabilities. Eve remains
an architectural reference and is not a runtime dependency. See the
[integration contract](integration-contract.md) and
[HTTP compatibility matrix](mcp-connections-plan.md#shipped-http-slice-2026-10-23).

## Native resource integration execution

Google Workspace read/search uses the same integration definitions, account
connections, revisioned workspace bindings, tool descriptors and operation receipts
as other collections. The control/API process composes engine-independent adapters
from `packages/integrations`; no provider loop, browser dependency or new resident
service is introduced. Google resource OAuth is separate from owner identity login,
and encrypted refresh tokens remain in the control-process broker. Account-scoped
leases serialize refresh rotation without replaying HTTP within database transaction
retries. Explicit Gmail label, file, sheet range and calendar allowlists supplement
provider scopes. See [Google operations](google-integrations.md) for the scope map,
recovery process and real-provider deployment gates. Eve remains a reference only.
