# Usability workstream (2026-10-24)

Branch: `fix/usability-browser-mobile`. Tick items only after verifying them in the
running app, not just after the code compiles. "Local" means the isolated fixture
stack on this Mac; "live" means the Pi control plane plus real workers.

## Browser

- [x] Google sign-in is rejected ("This browser or app may not be secure"). Cause:
      headless Chrome for Testing, and a user agent containing `HeadlessChrome`.
      Workers now prefer installed Google Chrome and report a normal user agent.
      Verified locally: Google moves past the email step to the passkey/password
      challenge. Live: needs the Mac worker restarted on this code.
- [x] Browser opened on `about:blank` (shown as "nullblank"). An idle release
      wiped the last URL, and the URL sanitizer printed `about:blank` as origin
      `null` + path `blank`. Reopening now resumes on the page that asked for
      sign-in (verified locally after an idle release).
- [x] The takeover flow explains what to do: an in-conversation "Sign-in needed"
      card, numbered "1. Take control to sign in" / "2. Done — continue task"
      buttons, and the site name.
- [x] Watch the browser at any time without disturbing the agent ("Watch live" on
      every turn with browser activity, plus the globe button in the composer).
- [x] Agent cursor and click ring drawn in the page (ported from
      `autonoma/quarita`), visible live and in step screenshots.
- [x] Browser activity shown per turn: a screenshot strip with a full-size step
      viewer.
- [x] Live view follows popups/new tabs (for example OAuth sign-in windows).
- [x] Secure ephemeral credential input ("Sign in privately"): email, password and
      code are encrypted to the worker, typed into the matching field and
      submitted. Verified locally on a phone-sized screen: the site received them,
      and the password appears nowhere in the database, workflow state or logs.

- [x] Act like a person, not by selector (after the live CRM run failed to find
      Google's email field): snapshot refs, x/y from the screenshot, optional
      visually grounded descriptions (quarita-style, needs
      `HARNESS_GROUNDING_API_KEY`), real mouse/keyboard; new type/press/hover/
      scroll/select/wait/snapshot actions. Verified locally with Codex on Google
      sign-in: email typed via ref, Next clicked, passkey step reached.
- [x] Browser activity collapsed to one row with the latest screenshot; "All N"
      expands the strip.
- [x] Phone keyboard: tapping the streamed page in control focuses a hidden field,
      so the keyboard opens and keystrokes reach the remote page. Needs a check on
      the real iPhone.
- [x] Native browser UI that never shows in the stream no longer traps anyone:
      passkey sheets are replaced by a silent virtual authenticator (Google's
      "Try another way" → password works), alert/confirm/prompt are handled
      automatically and reported, and native dropdowns open as an option sheet
      for the person (and return their options to the agent). Verified locally.
- [ ] Optional: enable visual grounding (decide which OpenRouter key to use).

- [x] Phone sign-in on Google's passkey screen: "Buttons on this page" lists the
      page's buttons/links as large rows (from the accessibility tree; iframe refs
      supported), taps show a ripple and click on release, and "Zoom in" lets you
      pan the stream. Verified at iPhone size: list → "Try another way" →
      "Enter your password".
- [x] A browser waiting on a sign-in page stays open 15 minutes (not 2), and a
      stored Google sign-in URL reopens the account page instead of a 400 error.
- [x] Each message shows which worker picked it up.

## Agents reading history

- [x] Agents can read the conversation behind a shared decision and any of the
      owner's sessions: `decision_source`, `session_read`, `history_search`,
      `workspace_list` (bounded, paginated). Verified with Codex from another
      workspace.

## Settings

- [x] Adding a machine: name → paste setup into Codex/Claude on that machine →
      the page waits and shows when it connects. Address field moved under
      Advanced, with a warning when the page is opened via localhost.
- [x] Google: plain explanation of what it gives and that it is optional,
      direct Cloud Console links, and the client ID/secret are pasted in Settings
      (sealed on the control server; no `.env` edit or restart).
- [x] Developer-only text (env vars, secret bindings) moved out of the way.

## Mobile / iPhone

- [x] Web app manifest, Apple meta tags, icons and safe-area padding, so a
      home-screen app opens without Safari's bar. Needs a check on the real iPhone.
- [x] Sliding top nav replaced on phones by the section name plus the sections in
      the drawer, which closes after navigating.
- [x] Phone layout: no input zoom on focus, panel controls wrap. Checked at
      390×844.

## Round 3 (owner feedback, 2026-10-25)

- [x] Google sign-in stuck on "Verifying it's you" on the Mac worker: taps on
      "Try another way" did nothing (reproduced through the live UI). Every page
      now reports that passkeys are unavailable before site scripts run, so
      Google shows "Continue / Try another way" instead of opening Chrome's
      invisible passkey dialog; "Try another way" leads to the password option.
- [x] Tapping a workspace in the phone drawer closed the drawer. It now expands
      the workspace's sessions in place; "New session" or a session navigates.
- [x] The browser no longer takes over the screen or opens by itself. It is a
      card in the conversation, opened from the sign-in card or "Watch live",
      with an optional Full screen.
- [x] Fixed email/password/code inputs replaced by the fields the page is
      asking for right now (read from the page, refreshed as it changes), with
      the right phone keyboard. Values already in the page are shown; only
      fields you change are sent. The agent fills what it knows first.
- [x] The sign-in card no longer stays forever: it is compact, has Dismiss, and
      a new message in the session resolves it.

## Round 4 (owner feedback, 2026-10-25 01:00)

- [x] No more take/give control. The browser is shared: whenever the view is
      open you can tap, type and fill fields. An agent that needs a sign-in
      finishes its turn; your next message resumes it. (The old lease stayed
      held after the phone stream dropped during MFA, so the agent kept saying
      control had not been returned.)
- [x] The view reconnects by itself after the phone drops the stream (switching
      apps for MFA) and when you come back to the tab.
- [x] A busy host no longer stalls conversation turns. The CPU-load gate now
      applies only to build turns; memory gates still apply to everything. (The
      Mac at load 18 on 12 cores held a session pinned to it in the queue.)
- [x] Schedule cards and Decisions overflowed the phone screen because of long
      URLs in prompts and decisions. Text now wraps anywhere; measured at 390px
      on Schedules, the session schedule card, Decisions, Tasks and Settings.


- [x] An expired takeover left the browser "paused" forever, locking the agent out.
      It now returns to the agent.
- [x] One unconfirmed page load blocked the agent from ever reopening that URL.
      `navigate` is now a repeatable read; clicks/fills keep the strict ledger.

## Round 5–6 (2026-10-25)

- [x] Agents are told they run inside Meta Harness (control URL, workers, host,
      workspace, session) so the owner can refer to it without explaining.
- [x] Codex gets network in its sandbox (`gh`, package installs work).
- [x] Apps reload themselves after a deploy (build id check).
- [x] Web Push instead of Telegram-only: Settings → Notifications turns it on
      per device (iPhone: the Home Screen app). Notifies on needs input or
      sign-in, schedule review, failed or interrupted tasks; "result ready" is
      opt-in. Only events from the last 15 minutes are pushed.
- [x] Checked on the owner's iPhone: notifications arrive.
- [x] Page titles no longer break into fragments on phones ("Set / tin / gs").
- [x] The app frame is pinned to the screen instead of sized in viewport
      units, which iOS Home Screen apps can leave stale (page cut off above the
      bottom of the screen). Needs a look on the iPhone.

- [x] Hourly encrypted backups of the Pi control plane to Drive (owner key
      in Dashlane), with status in Settings and a push when they fail.

## Sessions handing work to sessions (2026-10-25)

- [x] A planning session gives tasks to other sessions (`session_send`), gets
      their reports back as new messages that wake it, and sends feedback or
      answers on the same task, up to 6 rounds. Workers ask the planner first
      and the owner only for purchases, deletions, sensitive actions or
      questions nobody else can answer. Reports are written for a reader who
      did not follow the work. Verified live with Codex on both sides: a task
      and its report (25 s), and a question answered by the planner (35 s).
- [ ] First real use on the Litho sessions.

## Where conversations run (2026-10-25)

- [x] Machine labels (automatic: agents, `browser`, architecture; owner-added
      in Settings → Machines, for example `asap7`) and per-session required
      labels under Advanced in the chat. Verified live with Codex: a session
      requiring `asap7` waited ("Needs a machine labelled asap7") until a
      worker got the label, then ran there.
- [x] Conversations no longer stay pinned to the machine they started on. The
      last machine is preferred; when it is off (or busy for two minutes)
      another continues with the conversation so far. Verified live with
      Codex: stopped the first worker after turn 1; the second answered a
      question about turn 1 correctly.
- [x] Agents run with full permissions by default; a session can be sandboxed
      under Advanced. A workspace working folder (Advanced) gives agents the
      real project checkout. Verified live: Claude and Codex each read and
      wrote in the folder, ran git, and followed its CLAUDE.md; a sandboxed
      Claude session could not write or run commands.
- [x] Agents move themselves between steps: `continue_on` (labels, note,
      reason) and `machines_list`. The chat shows the reason and "moved
      from". Verified live with Codex: step 1 on one worker queued a step
      needing `asap7`, which waited while that machine was off and then ran
      there.
- [x] Tech workspace folder set to ~/Documents/Projects/litho; Mac worker runs 3 agents.
- [x] Workers coordinate directly with `session_note` instead of asking the
      planner to relay (Chip Code was blocked on B0 waiting for a relay).
      Verified live with Codex: note, reply note, 25 s, planner not woken.
- [x] Task lists show short titles the planner gives, not the prompt's first line.
- [x] A machine without the workspace folder clones what it needs or moves to
      one that has it, instead of stopping.

## Next: skills

- [ ] Skills the owner asks for, stored like decisions, available to agents,
      global or per workspace; agents propose skills for repeated work
      (Hermes-style). Scope decision pending.

## Known bugs from handoff

- [x] `/api/state` without a workspace returned 500 after the seeded `business`
      workspace was deleted. It now uses the first real workspace.
- [x] Unread badge overlapped long workspace titles in the sidebar.

## End-to-end verification (always with Codex)

- [x] Local CRM-shaped task: Codex hits a login, asks for sign-in, the owner signs
      in privately from a phone-sized screen, Codex continues and reads the leads.
- [ ] Real CRM task on the live deployment (read-only; no CRM changes or outreach).
- [x] "Work on project X" (local, Codex): cloned `tomaspiaggio/treemux` with `gh`,
      created worktree branch `harness-readme-check`, explained the project, then
      in a follow-up turn added a README Testing section and committed locally
      (nothing pushed).
- [x] Common assistant tasks (local, Codex): Hacker News research through the
      harness browser (8 steps, all with screenshots); "every weekday at 9am check
      my CRM" produced an inactive schedule draft for review.
- [x] `pnpm check`, `pnpm test` (with real-browser tests), `pnpm build`,
      `pnpm smoke`, `smoke:browser-live`, `smoke:worker-enrollment` pass locally.
- [x] Redeployed `1d1e107` (native UI handling, user-agent cache) to the Pi and
      the Mac worker after checking no turns or takeovers were active.
- [x] Deployed `f91ac63` to the Pi: control and worker units point at
      `releases/f91ac63` (old checkouts kept; unit backups in
      `deployments/20261024-164555`). Pi check/test/build passed; Mac worker
      restarted on the same code. Google accepts both the Mac (Chrome) and Pi
      (Chromium) browsers up to the passkey/password step.
- [ ] Checked on the phone by the owner.
