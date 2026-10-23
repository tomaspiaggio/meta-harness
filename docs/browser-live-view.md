# Managed browser live view

The extension-based default and queued frame/input view have been superseded.
Patchright runs a dedicated persistent profile on each eligible browser host. An
owner can watch, take control, release it, and explicitly continue a login wait.

This follows Browser Use's separation between a live browser view, a human
checkpoint and an explicit same-session continuation. Browser Use is a reference,
not a dependency or hosted service used by this project:

- https://docs.browser-use.com/cloud/agent/human-in-the-loop
- https://docs.browser-use.com/cloud/browser/live-preview
- https://docs.browser-use.com/cloud/agent/observability

## What changed

The old path put each frame and input through a POST, SQLite queue, worker poll,
HTTP completion, database wait and response. The new path keeps those durability
mechanisms for agent actions and uses an ephemeral encrypted WebSocket for live
frames/input. CDP's Page.startScreencast supplies changing JPEG frames; acknowledged
input is sent directly to the browser. The relay runs in the existing launcher.
It does not expose arbitrary CDP commands, create another daemon, or make a native
agent process replayable.

Watch is read-only. Take control/Sign in takes an exclusive controller lease.
Click/type/paste and keyboard navigation work on the live canvas. Esc or Release
control submits no message. Continue task is the explicit action that resumes a
pending login task. Closing a watch view also submits no message.

Each stream is authenticated, encrypted between viewer and worker, bounded and
revalidated. Inputs verify the current controller/generation before dispatch.
Manual input and frames do not enter model history or the command ledger. Agent
step summaries omit fill values and can include screenshots. The conversation
shows up to 12 recent steps; old result images expire after 24 hours.

## Setup and migration

Use HARNESS_BROWSER_BACKEND=managed. Install the pinned browser with pnpm
browser:install, or validate an installed Chromium and set
HARNESS_BROWSER_EXECUTABLE (tested /usr/bin/chromium on this Pi). Both control and
worker need the live-stream update. The normal launcher supplies the WebSocket
relay even for loopback deployments; reverse proxies must pass WebSocket upgrades.
A separately hosted UI still needs access to that authenticated live gateway.

The new browser does not inherit a personal Chrome profile's login. Sign in through
takeover when needed, then reuse the persistent host profile. Moving to another
host may require another login. Keep old extension profiles/pairing files for
rollback; do not copy passwords or remove the user's personal browser data.

## Validation

Run pnpm check, browser-enabled pnpm test, pnpm build and pnpm smoke. On an isolated
fixture control (never real port 3000), run pnpm smoke:browser-live with
HARNESS_URL and HARNESS_SMOKE_DATA_DIR. The controlled page tests native pointer
and keyboard events, Tab, password paste, Backspace, explicit release, view reopen,
frame rate, input acknowledgement latency, no unsolicited messages and actual
agent-action screenshot history. Lifecycle tests cover slow/concurrent startup;
relay tests cover origin/owner auth, worker separation, read-only input rejection,
ownership changes and credential revocation.

A separate Pi acceptance worker connects outbound to the fixture control while
that control has no Mac browser worker. A local-only test page on the Pi records
fixture input for independent verification. HARNESS_TEST_BROWSER_LOOPBACK is only
honored with a fixture data directory and must never be enabled in personal
services. Stop/revoke acceptance workers after testing; retain test data separately.

The successful initial Pi run delivered 16 frames in 1.2 seconds and a 55 ms input
acknowledgement on this tailnet. These are measurements of the controlled fixture,
not a guarantee of every website's rendering speed or authentication behavior.
Real Google authentication and OAuth-client creation remain separate checks.
