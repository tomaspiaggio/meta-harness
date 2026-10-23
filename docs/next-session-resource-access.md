# Authenticated browsers without a Mac dependency

Recorded after the Google-login meta test on 2026-10-22; updated by the owner on
2026-10-23. This is a plan, not a claim that the capabilities below are implemented
or that Google setup succeeded.

Current decision: each eligible browser host uses its own persistent login state.
If it is signed out, request manual browser takeover so the owner can enter the
password/MFA on that host, including the Pi. Do not depend on the Mac browser, copy
its credentials, or add a password-manager subscription. Preserve valid sessions;
request login only when required. 1Password is a possible future integration, not
a prerequisite or current implementation task.

## What the test established

The task was claimed and executed on Pi host `jetdad`. Its report said the paired
browser was offline, no Mac execution resource was exposed, and its checkout was
still on the older `main` revision. It did not create Google credentials or change
the running installation. Confirm the browser's actual host/health tomorrow;
the report alone does not distinguish an offline extension from wrong placement.

The immediate problem is access to the requested authenticated resources, rather
than proof of a missing password. Worker enrollment, provider login, website login
and owner login are separate. Enrollment does not copy any of the other three.

## First: make the existing meta test work

- [ ] Inspect worker/browser health and report the execution host, browser host,
  backend, paired identity, authenticated account and code revision in one view.
  Do not expose cookie values, passwords or provider tokens.
- [ ] Start/select a compatible persistent browser on the Pi; expose actual
  interactive takeover so the owner can log into the required account there.
- [ ] Target the Google setup turn to the Mac, since it must edit that control
  installation's private environment. Verify the required revision is available.
- [ ] Verify the Pi agent completes a harmless authenticated read with the Pi
  browser while the Mac browser/worker is unavailable.
- [ ] Expose missing/offline resource requirements as a visible wait with a
  specific reason. A signed-out eligible browser requests login explicitly; do
  not imply a Pi shell has access to the Mac installation's files.
- [ ] Resume the Google setup through a new explicit turn after resources work.
  Do not replay the completed or interrupted native turn automatically. Inspect
  existing Google Cloud state before creating anything to avoid duplicate clients.
- [ ] Keep the restart after setup's own turn; verify actual Google sign-in,
  existing data and enrolled workers before considering the setup complete.

## Resource model and longer-term access

- [ ] Bind named browser identities to workspaces and permitted account/domain
  scopes; register host health, authentication validation and resource lifetime.
- [ ] Keep agent/browser placement independent, without a required Mac-hosted
  browser. Select another eligible host on resource loss, request login there if
  needed, and pause only when no suitable capacity or human input is available.
- [ ] For work that must continue with the Mac closed, provision a dedicated
  persistent Patchright profile on a compatible always-on host. Log in once using
  takeover and retain its encrypted supported state; validate it after restart.
  This is separate from the user's everyday Chrome profile, not an automatic
  clone of all personal sessions. Sandbox use requires service-specific state
  portability, provisioning and renewal validation.
- [ ] Use the existing secret-reference/backend boundary for non-browser tokens
  and application credentials, scoped to the task and released only when needed.
  Never put a whole password vault or provider authentication home in checkpoints.
- [ ] Keep password-manager automation deferred. Manual login is the initial
  path; do not require Dashlane to remain unlocked or add a paid subscription.
  Revisit an optional 1Password integration only if the owner chooses it later.

## Payment boundary

Leaving a password manager unlocked does not define what an authenticated agent
can do. An existing website session may permit purchases without autofill. Browser
navigation alone is also too coarse to establish purchase authorization.

- [ ] Default unattended automation to dedicated accounts/profiles without saved
  cards or broad finance/admin access where practical; reuse personal Chrome
  only for explicitly granted workspaces and services.
- [ ] Require an explicit, one-time owner approval for a concrete payment or other
  consequential operation, showing merchant, amount/currency, account and action.
  Bind approval to the operation and current ownership; expire it and invalidate
  it if details change. Prompt instructions alone are not enforcement.
- [ ] Route controlled writes through services that enforce policy and record an
  external receipt. For arbitrary websites where reliable enforcement is not
  available, stop before checkout and hand control to the owner. Do not promise
  general payment prevention inside unrestricted personal-browser automation.
- [ ] During password/MFA/payment takeover, suspend agent control and model-facing
  screenshots/DOM capture; restore control only after the owner explicitly returns
  it. Do not give the model card numbers or a Dashlane master password.
- [ ] Preserve unknown-outcome handling: reconcile any ambiguous send/purchase;
  never retry it just because the worker or browser moved.

## Acceptance tests

- [ ] Pi agent + Pi browser completes a read-only authenticated test with the Mac
  unavailable; UI identifies the actual hosts.
- [ ] With the Mac disconnected, a signed-out Pi browser requests interactive
  login, accepts the owner's password/MFA through takeover, then continues.
- [ ] Loss of any browser host selects eligible capacity or pauses clearly; do
  not automatically replay interrupted native execution or ambiguous mutations.
- [ ] Restart the always-on browser: supported login state survives or a specific
  manual-login request appears; there is no silent signed-out fallback.
- [ ] Wrong-account/unauthorized-domain tests fail before protected access.
- [ ] A controlled test checkout requires fresh owner approval; changed amounts,
  expired approvals and stale worker generations cannot reuse it. Use fixtures,
  never a real charge, to validate this boundary.
- [ ] Verify no login secrets appear in model history, logs, published artifacts
  or portable checkpoints. State remaining isolation limits explicitly.

Related: [architecture](architecture.md#browser-identity-and-optional-capacity),
[browser options](browser-connection-options.md), and
[implementation checklist](implementation-checklist.md).
