# Meta Harness implementation checklist

Updated: 2026-10-21. This is the delivery checklist for the architecture agreed in
conversation. Checked items mean implemented with the stated evidence, not an
assumption that real hardware or hosted deployment has passed. Keep updating this
file as slices ship. Existing personal sessions/vault migration remains deferred.

## Current deployment preference

- [x] Record Pi-first private deployment over Tailscale. Vercel hosting remains an
  optional later move; no public deployment is required for local development.
- [x] Fix the development compilation/reload loop caused by static tracing of the
  runtime data path. A browser regression preserves an unsent draft while real
  worker/database/checkpoint activity runs.
- [x] Add accessible delete controls and confirmation for sessions and workspaces,
  transactional cascading deletion, stale-worker fencing, durable external/object
  cleanup and reconnect cleanup of worker caches. Published shared decisions stay
  in the shared Decisions collection; no existing user workspace was deleted.

## Boundaries and deployment

- [x] pnpm / TypeScript / Turborepo; engine-independent core and runtime adapters;
  Workflow composition stays in `apps/web`. Eve remains a reference, not a dependency.
- [x] Agents start on demand and exit between turns. Harness admission settings
  affect only harness work; no machine-wide limits or unrelated-process termination.
- [x] Shared decisions are injected at each turn and publication is revision-checked;
  cross-workspace recall and update benches pass for both provider flavors. In-turn
  freshness, selective audiences, and canonical git ingestion remain future work.
- [x] Accepted messages and output survive closing the browser tab. Application
  state uses optional local SQLite or Prisma/PostgreSQL; local orchestration uses the
  Local World and hosted orchestration uses the managed Workflow World.
- [x] Implement provider-neutral PostgreSQL persistence with Prisma, using Supabase
  initially as the database host. No Supabase client, Auth, Realtime, or database
  extensions should be required for ordinary application behavior.
- [x] Replace synchronous persistence dependencies with async repository contracts;
  preserve atomic claims, ownership generations, outbox dispatch, expected-revision
  publication, and idempotency. Do not hold database transactions across network calls.
- [x] Add versioned Prisma migrations and a non-destructive SQLite export/import
  tool. Rehearse on a copy, compare IDs/counts/content, and retain the original DB.
- [x] Test against ordinary PostgreSQL, including separate concurrent connections,
  transaction retries, UTC timestamps, pooling, and fresh-database restore. Release
  rollback/off-device recovery on the chosen infrastructure remains an external gate.
- [ ] Host the responsive UI, API, and orchestration on Vercel, using the managed
  Workflow world. Application records stay in PostgreSQL; large objects use a
  storage port. Self-hosted control remains an architectural option.
- [x] Replace local process dispatch timers and five-second outcome polling with
  hosted durable dispatch/wakeups and reconciliation. Bound workflow histories;
  sessions must outlive individual workflow runs and deployments.
- [ ] Verify phone access, reconnect/history recovery, backups, and restore. A
  hosted database removes Mac dependence, not all availability failure modes.

## Hosted security and scoped secrets (required before deployment)

Publicly reachable must never mean publicly authorized. A compromised hosted
control plane is also a potential remote-execution threat; authentication alone
does not isolate a trusted worker from malicious jobs.

- [x] Existing private gateway separates administrator and worker credentials,
  rejects cross-origin writes, and hides local Workflow control endpoints.
- [x] Add hosted owner authentication (OIDC/passkey-capable provider, explicit owner
  allowlist), secure expiring sessions, logout/revocation, and CSRF/origin checks.
  Fail closed without configuration; never infer hosted safety from loopback mode.
- [x] Authorize every application route and object read, including events,
  attachments, native checkpoints, browser screenshots, and encrypted takeover relay
  traffic. There is no public takeover WebSocket/CDP listener.
- [ ] Evaluate deployment protection as an additional gate, including production
  domains. Preserve correctly verified Workflow callbacks and Telegram webhooks;
  no broad unauthenticated bypass or browser-held worker/admin secret.
- [x] Workers connect outbound over HTTPS; no public shell, Docker socket, CDP, or
  machine administration endpoint. Restrict permitted job roots/tools/resources.
- [x] Isolate agent processes from daemon enrollment files and host credentials.
  The optional Linux container supervisor uses separate session UIDs; its permission
  fixture passes. Ordinary Mac workers remain trusted same-user processes, and a
  real deployment/container/provider audit is still required.
- [x] Introduce a secrets-engine port: named references, explicit per-workspace/job
  grants, short-lived delivery, redaction, cleanup, revocation, audit, and ownership
  validation. Choose a backend separately; do not put raw secrets in prompts, git,
  transcripts, ordinary DB rows, or Workflow arguments/history.
- [ ] Keep personal provider authentication local where supported. Validate headless
  account entitlement/renewal separately on Pi and Sandbox; retain an explicit
  API-backed option. Hosting does not make subscription credentials portable.
- [ ] Encrypt browser/provider bundles with keys outside object/database backups;
  define key recovery, rotation, retention, and deletion before real accounts.
- [x] Exercise unauthenticated reads/writes, forged/revoked workers, replayed events,
  stale generations, cross-session attachment access, webhook forgery, and secrets
  isolation before enabling a public deployment.

## Session controls and attention

- [x] Stop pending/queued work immediately; request cooperative termination for
  running work, show Stopping until acknowledgment, and preserve partial output.
  Stop cannot undo already-submitted external effects.
- [x] Keep the composer usable during work: Send next queues a distinct turn;
  Interrupt and send explicitly stops current execution before the follow-up runs.
  Use native steering only where the adapter proves it supports it.
- [x] Persist feedback/control requests with idempotent delivery and generation
  checks. Test a completion racing a stop and a lost acknowledgment.
- [x] Preserve one executing turn per session while supporting multiple waiting
  messages in submission order.
- [x] Route schedule occurrences through that same input serialization path.
- [x] Add durable unread state for completed/failed/interrupted turns: badge the
  session and its collapsed workspace, sort unread sessions first, persist read
  cursors across devices, and preserve updates newer than the displayed cursor.
- [x] Extend attention events to requests for input/login/approval, with distinct
  needs-input presentation. Avoid reordering on every streamed fragment.
- [x] Add a pencil to rename a session (keyboard/mobile accessible); manual titles
  must never be overwritten by automatic naming.
- [x] Generate concise titles asynchronously with a configurable cheap utility
  model, independently of the main runtime. No tools, resident process, or response
  delay. Show failures harmlessly; document separate API billing if used.

## Schedules and reminders

A schedule is a one-time or recurring trigger that sends its stored prompt to a
durable destination session. Each occurrence has an execution record, not a fresh
conversation. Default destination: the session that created the schedule; an
existing session or one dedicated persistent session can be selected instead.

- [x] Store schedule ID/revision, name, prompt, destination session, timezone,
  one-time date or cron expression, status, next occurrence, and last result.
- [x] Provide agent tools for proposing schedules, listing, revising drafts, pausing,
  and deleting them. The agent translates natural language into validated data;
  activation/resume and Run now use the authenticated owner UI.
- [x] Before activation, show an editable review card with the exact prompt,
  destination, timezone, and upcoming times. User acceptance activates the exact
  reviewed revision; feedback revises the draft, with no hidden live trigger.
- [x] Add a Schedules tab with review drafts, active/paused state, run history,
  next/last run, edit, pause/resume, run now, and delete.
- [x] Keep cron interpretation and occurrence calculation engine-independent;
  use Workflow durable timers or a bounded dispatcher behind that contract.
  Vercel deployment-configured Cron is not one dynamically deployed job per user
  schedule. Consider a reconciliation cron for missed dispatch.
- [x] Respect named timezone and daylight saving time; show concrete upcoming
  occurrences rather than trusting a model-generated cron expression.
- [x] Deduplicate occurrence IDs; invalidate old timers on edits/deletion and
  serialize occurrences with manual turns. Default to coalescing missed recurring
  reviews; make expiry/catch-up explicit for time-sensitive work.
- [x] Simple reminders post a message/notification without a model or execution
  worker. Investigations enter the resource-aware worker queue.

## Telegram and notifications

- [x] Research official Chat SDK adapters first. Telegram adapter exists and
  supports verified webhooks, allowed user IDs, and durable-state integration.
- [x] Use Chat SDK with the official Telegram adapter and PostgreSQL state where
  suitable; keep SDK-specific types outside core and avoid adding Redis.
- [x] Maintain a durable session <-> bot/chat/topic mapping. Create one topic for
  each connected session, reuse it across turns and schedule runs, and propagate
  renames. Validate private-chat topics and forum-group fallback on actual clients separately (pending
  external gate). The official-adapter fixture exercises message_thread_id and
  native topic creation against a local fake Telegram server.
- [x] Prove adapter handling of `message_thread_id` and topic creation. Bridge any
  missing native topic method in a narrow adapter, not core or a parallel bot stack.
- [x] Deliver completion, reminder, failure, login, and input-required notifications
  through a durable outbox with deduplication, retry, delivery status, and preferences.
- [x] Route authorized topic replies to the mapped session through an atomic durable
  inbox. Web UI and Telegram share the same turn/control path. Exact schedule/input
  revision approval currently uses authenticated UI links; native Telegram approval
  buttons are deferred convenience work.
- [x] Use authenticated deep links to session/browser takeover; enter credentials
  in that browser, not Telegram. Avoid exposing sensitive content in notifications
  by default. Notification delivery is independent of marking a session read.

## Attachments

- [x] Support clipboard images, drag/drop, and a file picker, with previews,
  filenames, removal before send, progress, and clear size/type limits.
- [x] Store immutable attachment metadata/object references separately from
  transcripts. Enforce authorization and bounded streaming uploads/downloads;
  use a local object adapter initially and a provider-neutral hosted adapter later.
- [x] Tie attachments to the submitted message and materialize them in an isolated
  session attachment directory on the assigned worker. Include them in recovery
  manifests; do not depend on Mac paths or temporary public URLs.
- [x] Pass supported images through provider-native multimodal input. Expose other
  files with explicit tool-readable paths; do not silently pretend all formats are
  directly understood. Report adapter limits before dispatch.
- [x] Test provider input fixtures, binary integrity, traversal/symlink defense,
  cross-session denial, retries, failed submissions, and worker relocation.

## Browser experience and identity

- [x] Define an engine/provider-independent browser tool port, scoped by identity,
  workspace, account/service, and exclusive controller lease.
- [x] Provide a harness-managed headed Chromium/Patchright host, start on demand,
  retain supported state, and stop after an idle timeout. Browser placement is
  independent of agent placement; no always-running browser pool by default.
- [x] Show current URL/action and screenshots after meaningful actions; add an
  expandable live view plus Take control / Return to agent.
- [x] Implement the measured alternative: encrypted JPEG frames/input over authenticated
  HTTP, with ephemeral UI/worker keys, exclusive identity control and expiring
  takeover leases. Real worker + headed Mac UI passes; actual Linux/phone performance
  remains an external gate. No additional VNC daemon is resident.
- [x] Pause agent input and model-visible capture during manual login/MFA. Validate
  account state and refresh context when control returns. Do not record credentials.
- [x] Validate clean browser state export/import with pinned compatible versions in a
  real Chromium fixture on this Mac.
  Device-bound sessions may need fresh login; never copy a live profile blindly.
- [x] Add optional local Claude --chrome integration. Actual noninteractive extension
  permissions, visible activity and login remain an external compatibility gate.
  This does not grant Codex access or relocate a Mac browser.
- [ ] Test Alcatraz lookup with visible navigation/screenshots, manual takeover,
  return to agent, restart/login recovery, and loss of the browser host. Checkout
  can pause for credentials/approval; full unattended purchase is not required.

## Workers, portability, and optional Sandbox capacity

- [x] Custom worker enrollment: random per-worker secret, stored hash, authenticated
  outbound reports/claims/events, revocation, leases, and generation fencing.
- [x] Fixture bench verifies Demo checkpoint recovery after abrupt worker loss and
  rejects old-generation writes. This is not proof of native provider portability.
- [x] Add workspace capacity policy plus existing per-task worker affinity: wait for personal workers, allow
  Sandbox fallback, or prefer Sandbox. Match capabilities, not just online status.
- [x] Add cold Sandbox provisioning with expiring worker identity, scoped secrets,
  vCPU/memory/concurrency/start-budget/lifetime bounds, a pinned snapshot preparation
  command, separate native UIDs, and teardown. Actual cloud provisioning/authentication
  is unverified and disabled by default.
  If required browser/auth/native checkpoint is unavailable, wait visibly.
- [ ] Validate same-provider native state plus file checkpoint transfer after a
  completed turn on real hosts for both providers. Interrupted native execution
  must not retry automatically; reconcile effects or pause for explicit follow-up.
- [x] Persist externally consequential operation IDs, idempotency keys/receipts,
  and unknown outcomes. Reconcile ambiguous effects rather than blindly repeating.
- [ ] Enroll an actual Pi and verify ARM64 dependencies, authentication, resource
  admission, runtime streaming, remote files, and browser support where selected.
- [ ] After deployment, start controlled work on Mac, disconnect its network,
  expire the lease, and verify eligible safe work continues on Pi; native work
  without proven recovery pauses. Reconnect Mac and reject stale results/actions.
- [ ] Repeat with sleep, hard kill, provider crash, control outage, lost completion
  acknowledgment, credential revocation, Sandbox timeout, and missing browser.

## Delivery gates

- [x] Run `pnpm check`, `pnpm test`, and `pnpm build` after each meaningful slice;
  run `pnpm smoke` for execution changes. Use provider fixtures by default.
  Delivery evidence below records the final results, including additional gates.
- [ ] Exercise public-auth/security checks, PostgreSQL persistence/restore, real
  Mac/Pi failure tests, Telegram topic routing, and browser takeover before calling
  the hosted harness ready. Update this checklist with concrete evidence.

## References

- [Chat SDK adapters](https://chat-sdk.dev/adapters)
- [Telegram adapter](https://chat-sdk.dev/adapters/official/telegram)
- [Telegram topics](https://core.telegram.org/bots/api#createforumtopic)
- [Workflow durable waits](https://workflow-sdk.dev/docs/api-reference/workflow/sleep)
- [Eve scheduling reference](https://github.com/vercel/eve/blob/main/docs/schedules.mdx)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)

## Delivery evidence

2026-10-21 — session controls and attention slice:

- Implemented Stop in chat and task board, queued feedback, atomic interrupt-and-send,
  sidebar manual rename, unread ordering/workspace badges, and monotonic read cursors.
- 48 fixture/unit tests passed, including two independent DB connections,
  out-of-order dispatch, stop/restart, completion races, no replay after explicit
  stop, and a result arriving after an older viewed snapshot.
- `pnpm check` and production `pnpm build` passed. `pnpm smoke` passed against an
  isolated local production server and real HTTP worker, with Demo delay 2500 ms.
  The stopped execution retained only its first output chunk; its queued correction
  then completed. No provider/model calls were made.
- At this slice, browser takeover, uploads, automatic small-model naming, schedules,
  Telegram, and Prisma/Postgres were still pending; see the expanded delivery below.
  Native cross-host recovery and public deployment remain external gates.


2026-10-21 — expanded local implementation (validated locally):

- Async repositories, Prisma 7 PostgreSQL, nine versioned migrations, preserved
  SQLite default, read-only transfer/export and verified transactional import.
  Real PostgreSQL concurrency, rollback/restore and schema-drift checks pass.
- Completion hooks with per-run waiters, durable wakeups/reconciliation, hosted
  owner OIDC/session scaffolding and deployment/cron configuration. Actual hosted
  login/deployment still needs your external configuration.
- Reviewed one-time/recurring schedules, exact prompts, persistent destinations,
  DST/overlap/stale-timer protection, worker-free reminders and Schedules UI.
- Paste/drop/picker attachments, immutable receipts and native image/file input;
  encrypted large worker payloads avoid hosted function limits. >4.5 MiB native
  upload/load, checkpoint and claim recovery passed against the local HTTP stack.
- On-demand Patchright host, visible screenshot panel, encrypted manual input/frame
  relay, supported state export/import and return to the same conversation. Real
  browser/UI fixtures pass on this Mac. No real service account was imported.
- Chat SDK Telegram adapter, PostgreSQL state, durable topic mapping, verified
  inbox before acknowledgement, atomic replies and notification outbox. Fixture
  topic creation/routing, forged-webhook rejection and duplicate delivery pass;
  no real bot message was sent.
- Settings for resource policy, timezone, secret references, worker enrollment/
  revocation, Telegram connection, logout; cheap optional utility titles and
  manual-title protection. Native processes omit control credentials; known secret
  streams/entries are redacted and portable file capture rejects known secret bytes.
- Opt-in Linux session UID isolation passed in a temporary Docker fixture. Optional
  Sandbox manager/preparation code is present, bounded and disabled by default;
  no billable cloud sandbox was provisioned.
- Personal-session/vault migration, actual Pi/Jetson/native transfer, deployment,
  real OIDC/Telegram/service auth, backup/key rotation and full isolation auditing
  remain deliberate external/compatibility gates. Refer to operations.md.


Final validation on this Mac (Node 24, production Next.js build):

- `pnpm check` and `pnpm build` passed; all **72 tests passed with no skips** when
  ordinary PostgreSQL and the private Chromium cache were enabled. Provider calls
  were subprocess/SDK fixtures; no live model calls were made in this delivery.
- `pnpm smoke`, `pnpm smoke:features`, and `pnpm smoke:payloads` passed against an
  isolated production HTTP stack backed by PostgreSQL 17. These cover native-sized
  encrypted transport, attachment scope/integrity, completion hooks and reviewed
  persistent-session timers/reminders. Prisma schema comparison reported no drift.
- `pnpm smoke:ui` passed real managed Chromium takeover, tab-only frame decryption,
  manual navigation, return to the same session and phone-width navigation without
  client exceptions. `pnpm test:restart` and `pnpm test:security` passed.
- `pnpm bench` passed a forced worker crash and checkpoint/files recovery on the
  second fixture worker in **34,066 ms**, rejected stale-generation writes, then
  passed draining, planned transfer, duplicate submission and credential isolation.
  Both workers ran locally with Demo; this is not a physical Mac/Pi or native test.
- The bench exposed buffered-redaction/checkpoint inconsistency; progress now waits
  for all preceding output to be durable. Concurrent lease reconciliation is atomic.
  Both have regression coverage; interrupted native turns still never auto-replay.
- `pnpm test:isolation` passed with all container capabilities dropped except
  CHOWN/SETUID/SETGID/DAC_OVERRIDE/FOWNER and no-new-privileges. Separate session UIDs
  could write their own files, could not read daemon/other-session files, and the
  supervisor could checkpoint and prepare the next turn.
- Temporary servers, browser contexts and the dedicated PostgreSQL fixture container
  were stopped after validation. No personal data was migrated, no real Telegram
  message was sent, and no cloud Sandbox/deployment was created.


2026-10-21 — deletion and development refresh:

- Reproduced rapid dev recompiles/reloads with mutable data inside the repository.
  Moving the data outside stopped it; reading its path at runtime rather than
  allowing compile-time environment tracing fixes it without relocating data.
  `pnpm smoke:dev-refresh` passed against the dev stack with data inside the repo:
  real DB/worker/checkpoint writes caused no navigation and preserved an unsent draft.
- Added confirmed session/workspace deletion, transactional cascades, durable
  cancellation/object cleanup, worker cache cleanup, bootstrap-once behavior and
  safe navigation after deletion. Published shared decisions retain their content
  and historical workspace ID while deleted conversation links are detached.
- 74 tests passed with PostgreSQL and Chromium enabled, including deletion,
  persistence after restart and PostgreSQL cascade/provenance. The ninth Prisma
  migration applied successfully; schema comparison reported no drift.
- `pnpm smoke:deletion` passed confirmation/cancel, required consent, deletion
  during running work, sibling isolation, full workspace cascade and navigation.
  Installed agent-browser also verified create, cancel, delete and navigation with
  no reported page errors using the harness's private Chromium executable.
- Pi-first private hosting is recorded; no Vercel deployment or user-data deletion
  was performed. Actual Pi installation remains a hardware validation gate.

- Final `pnpm check`, production `pnpm build`, `pnpm smoke`, and production
  `pnpm smoke:deletion` passed. `pnpm test:security` additionally rejects both
  session/workspace DELETE routes without owner credentials. The isolated worker
  had no remaining directories for deleted fixture sessions after reconnect cleanup.

2026-10-21 — document uploads and model selection:

- [x] Reproduce the silent PDF selection loss: a deferred state update read the
  live FileList after the input was cleared. Snapshot picker/paste/drop files
  synchronously before resetting or leaving the browser event.
- [x] Add persisted Settings defaults for Claude/Codex and separate preferred
  models; seed new sessions without modifying existing ones.
- [x] Add a composer model selector, including exact custom IDs. Existing sessions
  can change models while retaining their native provider/session identity.
- [x] Freeze model choice transactionally per submitted turn, including queued
  messages; pass it to both CLI adapters and Claude SDK on native continuation.
- [x] Add SQLite upgrades and Prisma migration 10; protect preferences with owner
  authentication and expose the route through the explicit private-host gateway.
- [x] Validate PDF retention, 6 MiB binary delivery, accented filename, download
  integrity, worker bytes and reselection in real Chromium. This is an upload
  fixture, not evidence of semantic PDF extraction by a live model.
- [x] Validate Settings, inheritance, mid-session changes, immutable queued model
  choices, reload persistence and phone-width layout in Chromium with no live
  provider calls. Unit/integration coverage includes native continuation arguments,
  Claude SDK options, restart persistence and independent PostgreSQL clients.
- Final `pnpm check`, `pnpm build` and all **77 tests passed with no skips** using
  an isolated PostgreSQL 17 container and private Chromium cache. Migration 10
  applied successfully and Prisma reported no schema drift. Production-stack
  `pnpm smoke`, `pnpm smoke:pdf`, `pnpm smoke:models` and `pnpm test:security`
  passed. No live provider calls, account migration or cloud deployment were made.

2026-10-21 — recurring development compilation:

- [x] Add a regression at the real Next dev seam: trace static-path discovery
  during actual worker polling and verify draft retention using headless
  agent-browser. The earlier no-navigation-only check missed this process churn.
- [x] Reproduce repeated `/api/worker/[action]` analysis in fresh Node processes.
  Moving data outside the repository did not stop it. Next dev invokes static-path
  discovery for dynamic routes, including these POSTs; `force-dynamic` alone did
  not prevent it.
- [x] Send upgraded worker JSON, attachment and encrypted payload traffic through
  static `/api/worker?action=...`, retaining the existing authenticated handler
  and legacy route compatibility. Admit the static endpoint through the gateway.
- [x] Regression fails before the change and passes with no worker-route analysis
  launches afterward. Browser smoke scripts now run headlessly on macOS.
- Final validation: `pnpm check`, `pnpm build`, all 77 tests with PostgreSQL and
  headless Chromium (no skips), `pnpm test:security`, `pnpm smoke` and
  `pnpm smoke:payloads` passed. The strengthened `pnpm smoke:dev-idle` also
  completed a checkpointed Demo turn while polling, retained the unsent draft in
  headless agent-browser and observed zero worker static-path analysis launches.
  Temporary services/containers were stopped. No live model calls were made.

2026-10-21 — schedule permissions, naming, worker guide and owner decisions:

- [x] Fix unattended Codex MCP approval policy on the attempt-scoped harness
  server. Preserve workspace-write shell isolation and owner-only schedule
  activation. Already failed requests require explicit follow-up, not replay.
- [x] Add scoped `session_title` suggestions to normal native turns and include
  the current title/source in their instructions. Improve offline fallback topic
  extraction, preserve manual names, and retain optional cheap utility naming.
- [x] Add Settings worker installation steps: Git clone, Node/pnpm requirements,
  dependencies, provider login, enrollment, private credential transfer, startup,
  online verification and upgrades. Allow enrollment to store a worker-reachable
  control URL and validate it before issuing a credential.
- [x] Add owner decision edits, confirmed withdrawal and restoration. Append
  revisions, preserve historical content/provenance, reject stale writes and
  support decisions whose source workspace was deleted previously.
- [x] Validate all 81 tests with PostgreSQL and headless Chromium, type checks,
  production build, owner-auth rejection and workflow smoke. Headless
  agent-browser verified decision edit/cancel/withdraw/restore, worker guide,
  the schedule review card and phone-width layout without reported page errors.
- [x] Explicit live compatibility test with installed Codex CLI 0.163.0 and
  `gpt-6-luna` created an inactive weekday review draft and short title in the same
  fixture session, without an approval-policy rejection. No schedule activated.
  The fixture is separate from real data and retained for inspection.
- Real data was only inspected read-only during diagnosis. No user workspace,
  session, decision, credential or schedule was deleted or reset; no migration
  was performed. The running personal server was not stopped by these checks.

2026-10-21 — stale worker after approval patch:

- Traced the repeated approval rejection to the still-running 19:18 worker,
  which predated the 20:03 adapter patch. Confirmed no active turns, then
  restarted that harness at 20:44 with its original environment, credentials
  and data; verified the same local worker returned Online. No turn was replayed
  and no user record was edited or deleted.
- Extended the opt-in native tools bench to cover both fresh and resumed turns,
  checking the same native ID and revision of the same inactive draft. A separate
  live resumed-thread check on `gpt-6.1-sol` passed schedule listing/revision in
  the retained fixture. No schedule was activated.
- `pnpm check`, `pnpm build`, and ordinary tests passed (77 passed, four optional
  PostgreSQL/browser checks skipped in this run; those checks passed in the prior
  81-test run). Personal UI remains on port 3000. The separate fixture stack was
  stopped after testing; test records remain intact.

2026-10-21 — automatic browser access:

- [x] Remove workspace enable controls and backend opt-in checks. New and legacy
  workspaces always have browser capability, without rewriting stored policies.
- [x] Keep browser processes on demand, idle shutdown and persisted profiles.
  Default to headless on macOS as well as Linux; use the installed full Chromium
  binary in headless mode.
- [x] Remove the obsolete workspace-availability check from Sandbox provisioning;
  explicit browser task requirements still control placement.
- [x] Add a shared backend connecting to this Mac's existing Chrome
  through its approval-based auto-connect protocol, with designated automation
  tabs, screenshots and the same broker ownership/takeover rules. This is distinct
  from copying credentials or exporting every login to another machine.
- Validation: all 81 tests passed with PostgreSQL and real headless Chromium;
  `pnpm check`, `pnpm build`, workflow smoke and browser UI smoke passed. The UI
  reached encrypted takeover directly without an Enable button. Temporary browser
  hosts and PostgreSQL were stopped. The personal harness was reloaded only after
  confirming no active turns, queued/running browser commands or human takeover,
  preserving its original environment and data. No personal Chrome was connected.

2026-10-21 — existing Chrome identity:

- [x] Default Mac workers with Chrome installed to personal Chrome attachment;
  keep managed profiles as an explicit setting and the default on other hosts.
- [x] Discover the running Chrome through its local DevToolsActivePort; preserve
  Chrome connection approval, create background tabs and reuse live account state.
- [x] Apply page-level routing only, export no personal credentials, leave user
  tabs/Chrome open on release, idle cleanup, forgetting an identity and shutdown.
- [x] Prefer the known personal Chrome host, visibly wait when unavailable and
  never silently fall back to a new unauthenticated profile.
- [x] Hide the idle browser card; show it for human-control requests or explicit
  composer browser action. Explain connection setup in Settings and errors.
- [ ] Validate the connection on the owner's actual Chrome after remote debugging
  is enabled and Chrome's connection prompt is approved. Installed Chrome 155 is
  supported; its discovery file was absent when checked. No personal cookies were
  copied and no website login was performed during implementation.
- Validation: `pnpm check`, `pnpm build` and all 84 tests completed (81 passed,
  three optional integrations skipped), including real headless Chrome attachment
  with existing cookies/local storage, no credential export, preservation of user
  tabs, and release/shutdown/reconnect. Headless agent-browser confirmed no idle
  card, actionable human-control requests and return-to-agent cleanup. The personal
  harness was restarted only while idle, preserving its original environment and
  data; its worker now reports `personal-chrome`. No personal Chrome connection
  was attempted while remote debugging remained disabled.
  `pnpm smoke` and `pnpm smoke:ui` also passed against the separate managed-browser
  fixture stack. That stack was stopped; all fixture and personal records remain.

2026-10-22 — Chrome connection failure recovery:

- [x] Reproduce the tool path incorrectly converting a failed Chrome connection
  to `unknown_outcome` and blocking later attempts on a blank page.
- [x] Distinguish failures before browser action execution with a worker-supplied
  `not_started` marker; preserve the persisted failure through outer catch handling.
- [x] Support explicit retries using the same logical operation ID and separate
  physical attempt records; retain prior command/error history. Continue blocking
  uncertain clicks and other actions that may have reached an external service.
- [x] Reconcile legacy connection failures from concrete failed-command evidence,
  including before injecting unfinished-operation context into subsequent turns.
- [x] Back up and reconcile the single affected personal navigation record. No
  records were deleted, credentials copied, or scheduled/native task replayed.
  Original snapshots are retained under `.data/backups/`.
- Regression test exercises the actual browser tool, broker, ledger and fake worker
  completion path: startup failure, legacy corruption, explicit retry with the
  same ID, retained attempt history and no duplicate uncertain click. Real browser
  fixture also verifies pre-execution failures carry the correct error type.
- Validation: `pnpm check`, `pnpm build`, full tests (82 passed, three optional
  integrations skipped) and `pnpm smoke` passed. Retry coverage includes a new
  user turn and rejects the earlier turn's expired ownership. The separate fixture
  stack was stopped. The personal server was already stopped and was left stopped.

2026-10-22 — host-independent browser resources (agreed design):

- [x] Define browser resources independently of agent execution and host type;
  support any eligible Mac, Pi, other machine or provisioned Sandbox worker.
- [x] Define resource, identity and lease responsibilities; retain Patchright for
  both extension-backed profiles and managed-browser adapters.
- [x] Document identity-aware placement, host-loss behavior, ephemeral lifetimes,
  independent resource budgets and supported authentication portability limits.
- [ ] Implement explicit browser-resource registration, capabilities and bindings
  instead of selecting an implicit single resource from worker browser flags.
- [ ] Replace global personal-Chrome preference with identity/resource-specific
  policy so desktop unavailability does not block other eligible browser resources.
- [x] Implement the extension/local-relay adapter with unattended reconnects and
  background tabs; validate with headless Chrome fixtures. Owner-profile setup
  and actual CRM verification remain the acceptance step below.
- [ ] Validate managed browsers on the actual Pi and eventual Sandbox runtimes;
  test agent/browser placement independently, including browser-only Sandboxes.
- [ ] Verify browser host failover/expiry, state restoration, authentication checks,
  explicit pause and uncertain-action protection without replaying native agents.

2026-10-22 — basic CRM reads and unattended extension connection:

- [x] Add bounded signed-in Google Sheets row reads, preserving gid and account
  selection; supplement ordinary page reads with accessibility labels/roles.
- [x] Omit form input values from agent accessibility reads and stop treating a
  successfully opened canvas editor as verified cell access.
- [x] Build a thin MV3 extension, one-time worker pairing and authenticated local
  relay; retain Patchright as the automation client. Make this the Mac default.
- [x] Keep owned tabs in the background, preserve user tabs, reuse existing login
  state, retain pairing and reconnect after relay restart without CDP approval.
- [x] Reject unauthorized client connections, website origins, invalid pairing,
  personal-tab commands, cookie export and browser-wide mutation commands.
- [x] Add worker-local `pnpm browser:pair` and step-by-step setup in Settings.
- [x] Pass `pnpm check`, `pnpm test` with browser fixtures enabled, `pnpm build`,
  `pnpm smoke`, and the headless UI/login smokes. Extension fixtures exercise existing authenticated
  state, Sheet rows, background tabs, relay restart and rejected connections.
- [x] Install and pair the extension in the owner's real browser profile; verify
  actual CRM rows and Calendar schedule content through the paired browser and
  harness worker. No additional remote-debugging approval or site login needed.

2026-10-22 — real scheduled CRM review browser failures:

- [x] Reproduce the Sheets `TrustedHTML` error with an enforced Trusted Types
  fixture; parse inert HTML on the worker without weakening Google's CSP.
- [x] Fetch actual `htmlview/sheet` content rather than its table-free shell;
  skip column-letter headings and retain bounded row/column/text/byte reads.
- [x] Reproduce Calendar's blocked 5–8 KB data URLs; allow bounded 64 KiB
  resource URLs while preserving the 4 KB navigation limit and network policy.
- [x] Add regression coverage for enforced CSP, authenticated cell reads, column
  headings and long resource requests; retain private-address/credential checks.
- [x] Wait briefly for declared page loading to finish before reading; label a
  timeout as a partial snapshot instead of implying that records are absent.
- [x] Verify the owner's CRM cells and loaded Calendar schedule without editing
  CRM data, sending outreach, or replaying the full schedule.
- [x] Pass `pnpm check`, browser-enabled `pnpm test` (87 passed; 3 optional
  integrations skipped), `pnpm build` and isolated local `pnpm smoke`.
  Restart the personal worker with the fix and retain all real application data.

2026-10-22 — agent-led worker onboarding:

- [x] Ask only for the device name and reachable control URL in worker enrollment.
- [x] Download a private Markdown handoff containing the scoped worker credential,
  clone/setup commands and instructions for the device's coding agent.
- [x] Cover provider/device login, model-free connectivity, optional paired Chrome
  or managed browsers, agent-only Pi operation and final Online verification.
- [x] Preserve JSON API compatibility, enrollment authorization and existing data.
- [x] Validate the actual headless download and authenticate a fixture worker
  using only the credential embedded in the generated guide.
- [x] Make enrollment copy the setup prompt and show "Paste to agent". Retain an
  optional Markdown download and manual-copy recovery if clipboard access is
  blocked, without enrolling the device twice.

Google login and Pi control deployment:

- [x] Add Better Auth Google login independently of hosting/database choice.
  Enforce verified-email allowlisting and disable legacy token bypass in Google mode.
- [x] Use encrypted eight-hour cookies plus the existing persistent owner-session
  ledger for immediate revocation; retain worker authentication separately.
- [x] Keep internal Workflow routes behind the gateway with a loopback HTTPS proxy.
- [x] Prepare a Headscale DNS/HTTPS, Google OAuth, data-preserving control migration,
  systemd startup and worker reconnection runbook in `deploy/pi-headscale.md`.
- [x] Pass `pnpm check`, `pnpm test` (87 passed, 7 optional integrations skipped),
  `pnpm build`, local Workflow smoke and headless Google auth/UI smoke. Exercise
  signed OAuth fixtures, verified-owner rejection and persistent revocation;
  actual Google login remains a deployment gate below.
- [ ] Choose the owned domain and configure Headscale DNS and its HTTPS certificate.
- [ ] Create the Google OAuth web client and enable the allowed owner account.
- [ ] Copy quiescent Mac control data to the Pi; preserve keys and verify records.
- [ ] Install/enable the Pi control service and reverse proxy; test restart/reboot.
- [ ] Verify actual owner login, workers and schedules on the Pi deployment.

Repository-aware coding sessions (agreed):

- [ ] Bind multiple repositories/worktrees, branches, exact commits and PRs to
  each coding session; track staged, unstaged and untracked state.
- [ ] Display linked repo/PR chips, branches, dirty status and current worker in
  the session header; expand for commit details and migration blockers.
- [ ] Gate handoff on pushed/bundled commits and a consistent dirty-file/native
  checkpoint; retain affinity or pause until restoration is safe.
- [ ] Verify exact-revision restoration on another host, dependencies, native
  continuation and ownership fencing without replaying interrupted native turns.

Next session — Google meta-test resource access:

- [x] Record the observed Pi/browser/revision blockers and tomorrow's ordered
  plan in `docs/next-session-resource-access.md`; preserve existing data and auth.
- [ ] Provide a persistent Pi browser and interactive login; verify authenticated
  work continues with the Mac unavailable. Target Mac-local config edits explicitly.
- [ ] Implement identity-specific resource readiness and visible waiting states.
- [x] Simplify login policy: reuse each host's valid session, ask for manual login
  when needed, require no Mac browser or password-manager subscription. Defer
  optional 1Password integration; do not implement Dashlane automation.
- [ ] Exercise host loss, supported login persistence, authorization, private
  takeover and payment-approval fixtures before unattended authenticated work.
