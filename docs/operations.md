# Running and validating the expanded harness

The lightweight default remains `pnpm build && pnpm start`: one control process,
one outbound worker, SQLite and local objects. An idle conversation has no agent
process. A browser starts only for browser work and closes after two idle minutes.
The worker reports resources every five seconds and backs idle claims off to five
seconds; queued work continues immediately when a slot finishes. These are harness
reservations and never change other applications' limits.

## Local acceptance

Use an isolated `HARNESS_DATA_DIR` for smoke/bench data. Existing personal sessions
and the Litho/vault migration remain separate from this release.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
HARNESS_DATA_DIR=/absolute/private/test-data HARNESS_PROVIDERS=demo pnpm start
# In another terminal:
pnpm smoke
pnpm smoke:features
pnpm smoke:payloads
pnpm test:restart
pnpm test:security
```

The smoke commands target the running local stack. Set `HARNESS_URL` for
another local port. Restart/security tests create and clean their own control
processes and temporary directories. `pnpm bench` tests worker crash recovery with
Demo; it makes no model calls. Never interpret a Demo pass as native-provider
migration evidence.

For browser testing, run `pnpm browser:install` on the browser host, restart its
worker, then use the Browser panel in a conversation. The installer uses the
harness's private cache and disables browser-cache garbage collection. It does
not modify another project's installed browsers.

```sh
HARNESS_TEST_BROWSER=1 PLAYWRIGHT_BROWSERS_PATH="$PWD/.data/browser-cache" \
  pnpm exec tsx --test packages/browser/src/browser.test.ts
HARNESS_URL=http://localhost:3199 HARNESS_SMOKE_DATA_DIR="$PWD/.data/live-browser-fixture" pnpm smoke:ui
pnpm test:isolation
```

`smoke:ui` and `smoke:browser-live` run the same headless agent-browser acceptance
flow against an isolated fixture control and available managed browser worker.
They verify live frames, native click/type/paste, password input, keyboard release,
explicit login continuation, action screenshots, no unsolicited turns and mobile
layout. They never use the personal port 3000. Mac headless and the actual Pi's
system Chromium have passed this flow; see [live browser validation](browser-live-view.md).
Use `HARNESS_SMOKE_DATA_DIR` for authenticated fixture `pnpm smoke` as well; its
owner token is read privately from that fixture, not pasted into commands.
Run `node scripts/dev-login-smoke.mjs` to exercise the actual development gateway:
it starts an isolated Google-configured fixture with dummy credentials and a Demo
worker, then verifies login hydration and eight seconds without reloads or repeated
auth checks. No Google authorization request or model call is made.
`test:isolation` uses a temporary, resource-limited Docker container and no network
inside it; the first run may download the Node test image.

## PostgreSQL and the non-destructive transfer

Set `DATABASE_URL` to ordinary PostgreSQL. Supabase is one hosting choice, not an
application dependency. Use TLS and a restricted application user. `DIRECT_URL`
can supply a separate connection for migrations, especially when the application
uses a transaction pooler. The application uses Prisma's PostgreSQL adapter with
three connections per control instance and a five-second idle timeout. Optional
Chat SDK state uses a separate two-connection pool; its pinned schema is owned by
Prisma migrations and it requires no Redis.

```sh
pnpm db:generate
DATABASE_URL=... pnpm db:migrate
DATABASE_URL=... pnpm start
HARNESS_TEST_DATABASE_URL=postgresql://... pnpm test
```

The integration tests create randomly named schemas and drop only those schemas.
Use a dedicated test database/user with schema creation permission. They exercise
independent clients, concurrent claims, serializable retries, stop/publication
transactions, Telegram fixtures, and a SQLite transfer rehearsal. Prisma schema
and migrations have also been compared for drift. The recorded delivery ran the
full suite with `HARNESS_TEST_DATABASE_URL`, `HARNESS_TEST_BROWSER=1` and the private
`PLAYWRIGHT_BROWSERS_PATH` set: 74 passing tests, no skips.

To move application data, stop writers, retain the source, and export a copy:

```sh
pnpm db:transfer export /private/source.sqlite /private/export.json
# Create a fresh empty PostgreSQL database and apply its migrations first.
DATABASE_URL=... pnpm db:transfer import /private/export.json
```

The export opens SQLite read-only and captures a consistent transaction. Its
0600 JSON file is private backup material. Import validates the checksum/schema,
refuses any populated destination table, inserts and verifies every application
column in one transaction, and restores sequence positions. Repeated import into
a populated DB is deliberately rejected. This command does not copy local object
files or browser encryption keys: copy/restore the object store and keep the key
backup separate. Do not run a new control process against the destination before
import, since that seeds rows. Rehearse on copies before moving real records.

For ongoing backups, use your PostgreSQL host's encrypted backups or `pg_dump` to
encrypted off-device storage, plus object-store backups. Restore into a separate
installation, verify session IDs/checksums and keys, and test a real conversation.
The transfer test is an application-data restore rehearsal; off-device backup
retention, key rotation and disaster recovery on your infrastructure remain gates.

## Vercel deployment preparation

Choose `apps/web` as the Vercel project root. Its build command generates Prisma
and builds the app from the monorepo. Run migrations as an explicit release step;
the web server does not migrate a live PostgreSQL schema automatically.

Configure the hosted variables in `.env.example`: PostgreSQL, a bare HTTPS public
origin, OIDC issuer/client, an owner subject or verified-email allowlist, a grant
signing key, a separate encryption key, timezone, and `CRON_SECRET`. Use an OIDC
provider that supports the login/passkey policy you want. Callback:
`https://your-origin/api/auth/callback`. PKCE, state, nonce and ID-token validation
are handled by `openid-client`; opaque owner sessions are hashed in PostgreSQL,
expire after eight hours, and are revoked by Sign out. Missing configuration fails
closed. Local administrator tokens are disabled in hosted mode.

Enable Vercel system environment variables so Workflow selects its managed World;
never deploy a Local World onto the read-only function filesystem. The Workflow
build integration registers its flow handler as a Vercel Queue consumer. Keep that
integration and verify the deployed consumer's protection. The private local
launcher separately hides all internal Workflow routes behind its allowlist.

The checked-in Vercel cron calls `/api/maintenance` every minute with the platform's
`CRON_SECRET` bearer credential. Use a plan that supports this frequency. It repairs
missed dispatch, completion wakeups, schedule timers, notification delivery, and
optional Sandbox capacity. Requests also use Next `after()` for prompt progress.
There is no resident dispatch timer on Vercel. Per-schedule Workflow timers still
carry the exact revision and due time; the cron is reconciliation, not one static
Vercel deployment cron per user schedule.

Configure private S3-compatible storage for hosted attachments. Give only the
control plane its bucket credential, configure CORS for the exact UI origin and
PUT/GET/HEAD/checksum headers, and keep the bucket non-public. Browser uploads use
short-lived signed PUTs with checksums; workers receive only authorized attachment
reads. Large native/checkpoint/claim transport uses encrypted, checksummed temporary
objects with per-attempt grants instead of large function bodies. The canonical
records remain in application storage. Configure the `meta-harness/worker-payloads/`
prefix to expire after a day, while preserving durable attachments under their
separate prefix. Local temporary payload cleanup is an operator retention task.
Text-only work with small state does not require object storage. The build excludes `.data`,
`.env*` and `.git` from function tracing.

Deployment Protection can add a second gate. Verify production-domain coverage and
that worker requests, maintenance and Telegram callbacks have deliberate access;
do not expose a broad bypass to agents or the browser. Owner authentication still
applies to every application/object route. Test public unauthenticated requests,
callback forgery, reconnect/history and phone access on the deployed installation.
No real Vercel/Supabase deployment or identity-provider login was performed here.

## Workers, secrets and isolation

Settings enrollment asks for a name and reachable control URL, then copies a
private agent handoff with that worker's credential and complete setup
instructions. The UI says **Paste to agent**; paste into a coding agent on the new device.
A Markdown download is optional, and blocked clipboard access exposes manual copy
without another enrollment. The agent writes
`~/.config/meta-harness/worker.json` with mode 600, verifies connectivity and
guides interactive provider/browser setup. Keep the Markdown private too. The existing
`pnpm worker:enroll` CLI remains available on the control host. Revocation rejects
new requests and existing attempt/tool grants. Workers connect outbound and expose
no shell, Docker socket, CDP listener or machine-administration endpoint.

Workspace resource policies choose personal capacity, Sandbox fallback, or Sandbox
preference; browser permission and named secret bindings are independent. Secret
references map through `HARNESS_SECRET_BINDINGS` only to `JOB_SECRET_*` deployment
variables. Values are fetched for a currently owned turn, omitted from workflow
history, and filtered into its runtime environment. Environment filtering omits
control DB, owner auth, Telegram and cloud administration credentials. Exact-value
stream redaction handles split chunks; native mirrored strings are also redacted.
Portable file checkpoints refuse files containing known granted secrets. This is
not a defense against a deliberately encoded or exfiltrated secret.

A process that receives a secret can use it. Removing a grant prevents future
fetches; stop the turn to terminate an already provisioned process, and revoke the
underlying service credential when needed. Local subscription auth remains local
and depends on each provider's supported entitlement/renewal. Nothing copies a
whole personal authentication directory to another host.

The ordinary Mac worker is trusted code running as your OS user. Environment
filtering is not filesystem isolation. For a separated Linux execution identity,
use `deploy/containers/worker.Dockerfile` or an equivalent dedicated supervisor
container. `HARNESS_ISOLATE_AGENTS=1` requires a root supervisor **inside that
container** and gives each session an unprivileged UID, private directory and home.
Never run the Mac daemon as root. Mount only its own credential read-only at
`/run/harness/worker.json` and its execution volume at `/work`; use
`--security-opt=no-new-privileges`, no Docker socket, no personal home and no
control-plane `.env` mount. The fixture drops all capabilities and adds only CHOWN, SETUID, SETGID,
DAC_OVERRIDE and FOWNER: the supervisor must also read/checkpoint and reprepare
files owned by the session UID. Validate both actual provider binaries and resource behavior
before advertising them. The fixture proves the Unix permission boundary; it is
not a complete container security audit or a multi-tenant security claim.

## Browser identity and login

Each workspace can enable one managed identity. Placement selects an online
browser-capable host with a free browser slot and headroom independently of the
agent's worker. Operations use a generation, exclusive controller and stable
operation IDs. Ambiguous mutations remain unknown rather than being replayed.
Browsers reject private-network destinations by default; a network egress boundary
is still required against DNS rebinding or a compromised browser process.

The Browser panel shows recent screenshots and the URL. Take control pauses agent
input and model capture. Its ephemeral P-256 key exchanges a transport key directly
with the browser worker: frames and keyboard/pointer input stay encrypted through
the API/database relay, and only this tab holds the private key. This measured
JPEG-frame alternative avoids a separate VNC daemon, display service and exposed
WebSocket/CDP endpoint. It currently targets about one frame per second and basic
click/type/key/scroll navigation, not smooth video, OS dialogs or hardware-key
forwarding. Closing the tab leaves manual control paused until return or its
expiring lease; it never silently gives an unfinished login back to an agent.

Return to agent clears the manual view and queues a continuation in the same
conversation. The agent rechecks page/account state. Cookies and supported local
storage are encrypted with a purpose-derived key outside PostgreSQL/object
storage; state can be restored on a compatible host. Full profile/IndexedDB/device-
bound credential relocation and service-specific login validation are separate
compatibility gates. Never copy a live profile directory between machines.
`HARNESS_CLAUDE_CHROME=1` enables the separate local Claude-extension path; it needs
its own real-client validation and does not give Codex the extension's access.

## Schedules, Telegram and titles

An agent's `schedule_propose` creates an inactive review card containing exact
prompt, timezone, trigger and destination. Only owner approval activates its current
revision. Edits return to draft. Schedules send into the originating conversation
by default; the Schedules form can select an existing session or create one
persistent dedicated session. Each occurrence has a stable ID, not a new session.
Recurring overlaps and missed runs coalesce; lateness is explicit. Simple reminders
post their stored text without a model or worker. Incoming answers use durable
input requests; sessions/workspaces surface needs-input and unread state.

Telegram is optional and requires PostgreSQL, a bot token, a strong webhook secret,
an exact chat ID and non-empty owner-user allowlist. Configure the webhook to
`https://your-origin/api/telegram` with that same secret. Use Settings to connect
one topic per session, or opt into `TELEGRAM_AUTO_TOPICS=1`. Bot topic capability
must be enabled; a controlled forum group is the fallback when a private-chat
client does not support topics. The official Chat SDK adapter handles topic IDs,
messages and PostgreSQL state. A narrow native bridge creates/renames topics. If
creation has an ambiguous result, inspect Telegram and enter the existing topic ID
instead of automatically creating another.

Webhook input is authenticated and persisted before acknowledging it. An inbox
survives server failure, while atomic input handling prevents a retried reply from
creating another turn or another answer. Outbound notifications use a separate
outbox with delivery receipts/backoff. They omit result contents and link to the
authenticated UI by default; credentials belong in browser takeover, never chat.
Notification retries can duplicate an alert after a lost external acknowledgement.
Reading Telegram does not silently mark the web session read. `/stop` cancels that
session's work. Files are currently uploaded through the UI. Actual BotFather/
private-client topic behavior still needs a real-account check; all tests used a
local fake Telegram server and made no real messages.

Titles use a bounded topic-word fallback until a utility endpoint, cheap model and
utility API key are explicitly configured. Native agents can also refine the
title with `session_title` during their normal turn, adding no separate model
request or idle process. Existing generated titles can improve on a later turn;
manual titles are protected. The optional OpenAI-compatible call has
no tools and a tiny output limit; it never starts a full Claude/Codex process or
blocks a turn. Its API billing is separate from subscription CLI usage. Manual
pencil titles always win. Claude's current `--bare` mode also requires API auth,
so `HARNESS_CLAUDE_BARE=1` is opt-in and default CLI execution retains subscription
login support. See [Claude's bare-mode documentation](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode).

Codex's unattended CLI approval policy does not itself approve MCP tools. The
adapter sets `mcp_servers.harness.default_tools_approval_mode="approve"` for the
attempt-scoped gateway only, retaining the workspace-write shell sandbox and
server-side authorization. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Restart workers after upgrading, then ask the existing session to retry creating
its schedule draft. Previously rejected turns are not replayed automatically.
An owner must still review and activate the resulting card.

`HARNESS_LIVE_CODEX_TOOLS=1 HARNESS_URL=http://127.0.0.1:3199 pnpm smoke:native-tools`
is an explicit live-quota compatibility check for a separate local fixture stack
advertising Codex. It uses Luna by default (`HARNESS_LIVE_CODEX_MODEL` can override),
proposes one inactive weekday schedule, suggests a title, and checks the actual
persisted result. A second live turn resumes the same native ID and lists/revises
that draft. It does not activate schedules or access external services.
Fixture records remain for inspection. Validated with Codex CLI 0.163.0.

The local worker is a cold-process supervisor, not a source watcher. Next dev
updates web code while an already-running worker retains imported adapter code.
After runtime changes, restart the launcher once current turns finish. A
19:18 worker continued rejecting MCP calls after the 20:03 adapter patch until
it was restarted; the application database and native threads needed no reset.

Use Decisions → Edit to update a record. Delete opens a confirmation and records
a withdrawal, retaining previous revisions. Show withdrawn decisions exposes
Restore. A revision conflict requires reading the newer record before resubmitting;
it never silently overwrites a concurrent agent update. No data reset or schema
migration is needed for these controls.

Settings → Workers copies an agent-led installation prompt using this project's
GitHub `main` branch. The control URL is the separate address you provide at
enrollment; use a reachable HTTPS address for another machine. The guide includes
the scoped credential, device/provider login, optional existing-Chrome extension
pairing, managed-browser compatibility and agent-only Pi operation. Keep both the
guide and resulting credential outside git. Worker credentials grant no
owner/database administration access. JSON enrollment remains the default API
response for existing clients; Settings requests `format: "markdown"`.

Run `HARNESS_URL=http://127.0.0.1:3199 pnpm smoke:worker-enrollment` against an
isolated fixture stack for a headless agent-browser check of the two-field form,
clipboard copying, blocked-clipboard recovery, optional Markdown download and worker authentication using its embedded credential.

## Agent models and document uploads

Settings persists a default agent and one preferred model per provider. The
composer can override the model for a new or existing conversation; changing it
does not reset native history. Each submitted message freezes its model, including
messages waiting behind a running turn. A provider change needs a new session.
The small suggestion list is not an entitlement check. Use an exact custom model
ID available to your account if needed; unsupported IDs surface the provider error
without automatically retrying the turn. These controls use the same runtime
authentication as before, and add no idle model processes or API calls.

Provider default delegates to the worker's `HARNESS_CLAUDE_MODEL` or
`HARNESS_CODEX_MODEL` override, then the provider's own configuration. Explicit
session models take precedence. Model selection uses native CLI `--model` and the
Claude SDK model option on resume. See [Claude model configuration](https://code.claude.com/docs/en/model-config)
and [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference).

Apply `pnpm db:migrate` when using PostgreSQL; migration 10 adds nullable model
columns. SQLite adds these columns at startup. No transcript conversion is needed.

The PDF picker fix snapshots browser file lists before clearing the input; it
also covers deferred reads during paste/drop. Documents retain the existing
10 MiB limit and worker file delivery. This is not a new PDF parser: native PDF
reading quality and available extraction tools depend on the selected runtime.

On an isolated, Demo-only local stack, run `HARNESS_URL=http://127.0.0.1:3000
pnpm smoke:models` and `HARNESS_URL=http://127.0.0.1:3000 pnpm smoke:pdf`.
Set `HARNESS_SMOKE_DATA_DIR` to that stack's data directory to additionally verify
PDF bytes on disk at the worker. These tests create/delete their own fixtures;
the model test restores preferences and deliberately leaves native turns queued
until cleanup so it makes no live model calls.

## Optional Sandbox activation

Nothing provisions billable Sandbox capacity until both
`HARNESS_SANDBOX_ENABLED=1` and a workspace capacity policy allow it. Prepare a pinned
public-repository revision with the explicit `pnpm sandbox:prepare --source ...
--revision <commit>` command, then validate its snapshot with Demo. The preparation
command itself starts billable build capacity; it was not invoked here. Its image
installs the pinned Codex CLI alongside the pinned Claude SDK. Configure provider
auth explicitly and validate it with a controlled task; an installed binary alone
does not establish account entitlement. See the [official OpenAI authentication
documentation](https://learn.chatgpt.com/docs/auth) for account versus API usage.

The capacity manager enforces concurrent and rolling-day start limits, a hard
sandbox lifetime, vCPU bounds, and one expiring worker identity scoped to one turn.
A root supervisor starts native children under separate unprivileged identities.
No database or Vercel administration credential is delivered to that worker. A
browser requirement, pinned non-portable native state, missing provider API grant,
paused task or specific personal-worker target prevents inappropriate fallback.
The worker receives job secrets only after it owns the assigned turn. Finished or
expired jobs revoke the identity and stop their sandbox. A provisioning result
with no confirmed receipt is held for inspection rather than started again.

Validate connectivity, actual image startup, secret isolation, timeout/teardown and
billing limits with your account before enabling real tasks. Native subscription
credentials are not presumed portable to serverless capacity. A native interruption
still pauses for explicit follow-up even when another worker is online.


## Pi-first hosting and deletion

Browser access is automatic in all workspaces, including those with old opt-out
records. No Settings checkbox or Browser enable button is needed. Chromium still
launches only on demand and closes when idle; profiles retain their own supported
login state. Hosts default to headless on macOS as well as Linux, so automation
does not open a separate desktop window. Install the private Chromium binary with
`pnpm browser:install` where a worker should host browsers. Host-level disabling
remains available for workers without browser resources and test/Sandbox fixtures.

Personal Chrome attachment is a separate, not-yet-implemented browser backend.
Chrome 144+ supports approval-based auto-connect to a running profile via
`chrome://inspect/#remote-debugging` and Chrome DevTools MCP `--autoConnect`.
It can reuse existing logins; Chrome requests connection permission. It depends
on that browser host remaining reachable and is not a portable login export.
See [Chrome auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect).

The current deployment preference is the Pi control plane over private Tailscale;
Vercel hosting is optional. Keep the same engine and repository ports. Validate
ARM64 runtimes, persistent Workflow storage, disk/backups and restart behavior on
the actual Pi before relying on it while travelling.

Trash buttons in the sidebar open an explicit confirmation dialog. A workspace
cascades through every session, including those outside the sidebar's recent
window. Published shared decisions stay in Decisions. Running agents lose gateway
access immediately and abort on their next heartbeat; external actions already
submitted cannot be recalled. Object/orchestration cleanup retries durably. Worker
cache cleanup waits for reconnection and completion/termination of affected
processes. Deletion does not purge native provider history, external Telegram
messages or retained backups.

`pnpm smoke:deletion` checks confirmation/cancel, active-turn deletion, sibling
isolation and workspace cascade against an isolated stack. Run
`pnpm smoke:dev-refresh` against `pnpm dev` to check that runtime writes preserve
an unsent draft without a page reload. Both use only disposable fixtures and the
private Chromium cache; no live model calls are made.

If the dev indicator keeps compiling while idle, restart `pnpm dev` with the
updated worker. Worker polling now uses `/api/worker?action=...`; the dynamic
legacy route caused Next dev to start static-path analysis processes repeatedly,
including fresh SQLite import warnings, even without a page reload. Older remote
workers need upgrading/restarting as well. Normal first-use route compilation and
HTTP poll logs still occur.

`pnpm smoke:dev-idle` starts its own isolated dev stack and uses installed
agent-browser headlessly. It traces Next's actual static-path discovery and
asserts that repeated worker polls launch no analysis processes, while preserving
an unsent draft. It failed before the endpoint change and passes afterward.
It must run separately from another dev/build process in this checkout. The
other browser smoke scripts also run headlessly on macOS; they use the harness's
private Chromium cache, with no browser window taking focus.
