export interface WorkerEnrollment {
  id: string;
  token: string;
  serverUrl: string;
}

/** A private, device-scoped handoff. Never include control-plane/admin secrets. */
export function workerOnboarding(name: string, credential: WorkerEnrollment) {
  const label = name
    .replace(/[\r\n]/g, " ")
    .replace(/([\\`*_{}[\]<>])/g, "\\$1");
  const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, "-") || "worker"}-setup.md`;
  const markdown = `# Set up Meta Harness worker: ${label}

These instructions are for a coding agent running on the new device. They contain
that device's enrollment credential. Keep this prompt or downloaded guide private:
do not publish it, commit it, or share it with other devices. Revoke this worker in
Settings if the setup credential is exposed.

## Instructions for the coding agent

Install and verify this worker on the machine where you are running. Do the
terminal work yourself. When human interaction is needed, give the user the exact
browser URL, button, local folder or device code and wait for that step to finish.
Do not ask the user to figure out installation instructions. Never invent login
URLs or codes: use those printed by the installed tools.

This is a worker, not a second control plane. Do not start the web UI, a database,
or a Workflow server here. Do not run pnpm dev. Preserve existing files, credentials
and repositories; do not reset or clean a checkout to make installation succeed.

- Repository: https://github.com/tomaspiaggio/meta-harness
- Branch: main
- Control URL: ${credential.serverUrl}
- Worker ID: ${credential.id}
- Owner verification page: ${credential.serverUrl}/settings
- Capacity/status page: ${credential.serverUrl}/tasks

## 1. Check this machine and install prerequisites

Inspect the OS, architecture, available memory and existing tools. Use a supported
64-bit Linux OS on Raspberry Pi. Install Git, Node.js 24 or newer and pnpm 10.10.0
using an appropriate supported method for this OS. Verify the active Node version;
older Node installations may appear earlier on PATH.

\`\`\`sh
node --version
npm install --global pnpm@10.10.0
pnpm --version
\`\`\`

Keep harness concurrency at one initially. Do not set machine-wide memory/CPU
limits or stop unrelated processes. No idle agent or browser process is required.

## 2. Clone the project

\`\`\`sh
git clone --branch main https://github.com/tomaspiaggio/meta-harness.git
cd meta-harness
pnpm install --frozen-lockfile
\`\`\`

If a checkout already exists, inspect its remote, branch and working tree first.
Reuse it when appropriate; preserve local changes. Read AGENTS.md, README.md and
docs/operations.md before configuring the worker. Workers run TypeScript directly;
a full Next.js build is not needed.

## 3. Save this device's credential

Create ~/.config/meta-harness with directory mode 700. Use your file-writing tool
to write the exact JSON below to ~/.config/meta-harness/worker.json, outside the
checkout, with file mode 600. Do not echo its token in logs or shell history.
If a credential already exists, check its worker ID before changing it. Reuse an
identical credential; stop and explain any conflicting enrollment to the user.

\`\`\`json
${JSON.stringify(credential, null, 2)}
\`\`\`

The serverUrl is already included. localhost and 127.0.0.1 refer to this new
machine, not the original control plane. If the control URL is unreachable,
diagnose private-network/Tailscale access with the user. Do not expose the control
plane publicly or change its security settings to work around connectivity.

## 4. Verify connectivity without model usage

From the checkout, start a temporary foreground worker:

\`\`\`sh
HARNESS_PROVIDERS=demo HARNESS_BROWSER_ENABLED=0 pnpm worker --credential ~/.config/meta-harness/worker.json
\`\`\`

Have the user open ${credential.serverUrl}/settings or /tasks and confirm this
worker is Online. Check its capacity report. Stop only this temporary worker when
finished; keep the same enrollment credential for the real worker.

## 5. Sign in to the agent providers on this device

Inspect which providers the user already has installed and authenticated. Set up
Claude, Codex or both as appropriate; advertise only providers that work locally.
Use their supported installation instructions:

- Claude: https://code.claude.com/docs/en/setup
- Codex: https://developers.openai.com/codex/cli

Inspect the installed CLI's help for supported login and device-authorization
flows. For a headless Pi, guide the user to open the actual authorization URL on
another device and enter the actual code printed by the CLI, when supported.
Passwords/MFA stay in the provider's browser flow. Do not request passwords in chat
or copy credentials from another machine. Verify local authentication before
advertising that provider; account support and renewal can differ by environment.

## 6. Choose browser capability for this device

A worker can run agents without hosting a browser; authorized browser tools may
use a browser host elsewhere. Do not require the user to install an extension on
a headless Pi just to run agents.

### Reuse an existing signed-in Chrome on this device

Patchright is the Playwright-compatible driver. The extension connects it to the
existing Chrome profile so background agent tabs use that profile's logins without
repeated remote-debugging approval dialogs.

1. Run pnpm --filter @harness/browser-extension build in the checkout.
2. Tell the user to open chrome://extensions in the Chrome profile they want to
   share, turn on Developer mode, click Load unpacked, and select the absolute
   apps/browser-extension/dist folder from this checkout. Give the actual path.
3. Start the real worker with HARNESS_BROWSER_BACKEND=extension (see below).
4. In a second terminal in the checkout, run:

\`\`\`sh
HARNESS_WORKER_TOKEN_FILE=~/.config/meta-harness/worker.json pnpm browser:pair
\`\`\`

5. Tell the user to click the Meta Harness Browser extension icon, paste the long
   pairing code printed in that terminal into its pairing field, and click Connect.
   Keep pairing codes private. Pairing survives worker/browser reconnects.
6. Confirm browserExtensionReady in the worker report. Do not ask the user to
   enable Chrome remote debugging, approve a connection dialog every time, or
   log in to every site again. Do not navigate or close their personal tabs.

### Separate managed browser on a compatible host

Check Patchright/Chromium support for the actual OS/architecture before enabling
it. Run pnpm browser:install, then use HARNESS_BROWSER_BACKEND=managed. This browser
has its own persistent logins; it does not automatically inherit another Chrome
profile's accounts. Guide any needed login through the harness's browser takeover
UI. If unsupported or unnecessary, leave this device agent-only.

## 7. Start the real worker

Stop the temporary connectivity worker first. For both authenticated providers:

\`\`\`sh
HARNESS_PROVIDERS=claude,codex HARNESS_CONCURRENCY=1 pnpm worker --credential ~/.config/meta-harness/worker.json
\`\`\`

Use only claude or codex if that is the sole authenticated provider. Add
HARNESS_BROWSER_BACKEND=extension for paired Chrome, or managed for a validated
managed host. For an agent-only worker, add HARNESS_BROWSER_ENABLED=0. Keep any
custom data-directory/browser configuration consistent with the pairing command.
Do not leave a second worker process using this same credential.

The worker runs in the foreground; closing its terminal stops it. If the user
wants unattended operation, configure a user-scoped systemd/launchd service with
the same command, environment and credential. Do not launch another control plane.

## 8. Finish with verification

Confirm Online, expected provider capabilities and capacity on /tasks. For an
extension browser, verify it reconnects after restarting only this worker without
another Chrome connection prompt. Use a harmless read-only browser test when
browser capability is enabled; do not edit CRM data or send messages as a test.
Use Demo for connectivity first. If provider verification needs a live model
request, intentionally select one minimal prompt and report that quota was used.

Report what is installed, where the checkout and credential live, how the worker
is started/stopped, which capabilities are working and any unresolved hardware or
login limitation. Do not call an untested Pi/Sandbox browser validated. Leave the
user with a working worker or a precise next interactive step.
`;
  return { filename, markdown };
}
