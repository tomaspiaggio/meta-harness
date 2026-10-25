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

## Found while testing

- [x] An expired takeover left the browser "paused" forever, locking the agent out.
      It now returns to the agent.
- [x] One unconfirmed page load blocked the agent from ever reopening that URL.
      `navigate` is now a repeatable read; clicks/fills keep the strict ledger.

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
