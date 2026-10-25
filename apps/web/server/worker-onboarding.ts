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

### Dedicated managed browser (default)

Use HARNESS_BROWSER_BACKEND=managed. Patchright starts its own persistent profile,
headlessly, on demand. No Chrome extension or pairing is required, and another
machine's saved credentials are not copied. Run pnpm browser:install on a compatible
host. On a Pi with supported system Chromium, use
HARNESS_BROWSER_EXECUTABLE=/usr/bin/chromium instead. Validate that binary on the
actual host; do not assume the architecture alone establishes compatibility.

The conversation UI shows the browser live and the owner can click, type and fill
the fields a page asks for at any time; the owner and agent share it. An agent
waiting for login finishes its turn, and the owner's next message resumes it.
Reuse valid host-local sessions. Password/MFA entry happens in that encrypted
view, never in chat. If this device cannot host a browser, leave it agent-only.

## 7. Start the real worker

Stop the temporary connectivity worker first. For both authenticated providers:

\`\`\`sh
HARNESS_PROVIDERS=claude,codex HARNESS_CONCURRENCY=1 pnpm worker --credential ~/.config/meta-harness/worker.json
\`\`\`

Use only claude or codex if that is the sole authenticated provider. Add
HARNESS_BROWSER_BACKEND=managed for a validated browser host. For an agent-only worker, add HARNESS_BROWSER_ENABLED=0. Keep any
custom data-directory/browser configuration consistent across restarts.
Do not leave a second worker process using this same credential.

The worker runs in the foreground; closing its terminal stops it. If the user
wants unattended operation, configure a user-scoped systemd/launchd service with
the same command, environment and credential. Do not launch another control plane.

## 8. Finish with verification

Confirm Online, expected provider capabilities and capacity on /tasks. For a
managed browser, verify live frames, direct input and retained login after a restart. Use a harmless read-only browser test when
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
