"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
export function WorkerSetup({ name }: { name: string }) {
  const defaultRepository = "https://github.com/tomaspiaggio/meta-harness.git";
  const [repository, setRepository] = useState(defaultRepository);
  const cloneSource = `'${(repository.trim() || defaultRepository).replaceAll("'", "'\"'\"'")}'`;
  const file = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-worker.json`;
  return (
    <div className="grid gap-3 text-sm">
      <p>
        Add one worker for each machine. It connects outbound to this control
        plane; it needs no database access and runs agents only when assigned
        work.
      </p>
      <label htmlFor="worker-repository-url" className="grid gap-1">
        Repository URL (for these instructions)
        <Input
          id="worker-repository-url"
          aria-label="Worker repository URL"
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          placeholder={defaultRepository}
        />
      </label>
      <ol className="grid list-decimal gap-4 pl-5">
        <li>
          <strong>Prepare the new machine.</strong> Install Git, Node.js 24 or
          newer and pnpm 10.10.0. On the Pi, use a supported 64-bit Linux OS.
          Run these commands on the worker:
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
            {
              "node --version\nnpm install --global pnpm@10.10.0\npnpm --version"
            }
          </pre>
        </li>
        <li>
          <strong>Clone and install.</strong> Run this on the Pi or other worker
          machine. These commands use this project’s main branch. A database or
          web server is not needed on the worker.
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">{`git clone --branch main ${cloneSource} meta-harness\ncd meta-harness\npnpm install --frozen-lockfile`}</pre>
        </li>
        <li>
          <strong>Sign in to the agent providers on that machine.</strong>{" "}
          Install the{" "}
          <a
            className="text-primary underline"
            href="https://code.claude.com/docs/en/setup"
            target="_blank"
            rel="noreferrer"
          >
            Claude CLI
          </a>{" "}
          and/or{" "}
          <a
            className="text-primary underline"
            href="https://learn.chatgpt.com/docs/cli"
            target="_blank"
            rel="noreferrer"
          >
            Codex CLI
          </a>
          . Open each installed CLI and finish its login. Provider credentials
          stay on that machine. Only advertise providers you installed and
          authenticated.
        </li>
        <li>
          <strong>Enroll below and transfer the credential.</strong> Enter a
          worker name and an HTTPS control URL reachable from it, then click
          Enroll worker. Move the downloaded <code>{file}</code> securely onto
          the worker, outside this checkout. On the worker:
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">{`mkdir -p ~/.config/meta-harness\n# Copy ${file} here as worker.json using scp or another secure transfer\nchmod 600 ~/.config/meta-harness/worker.json`}</pre>
          <p className="mt-1 text-muted-foreground">
            Treat the JSON file as a password. Do not commit it, paste it into a
            conversation, or share the database/admin token.
          </p>
        </li>
        <li>
          <strong>Start the worker from its checkout.</strong> Adjust the
          provider list to match its installed CLIs.
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
            {
              "HARNESS_PROVIDERS=claude,codex pnpm worker --credential ~/.config/meta-harness/worker.json"
            }
          </pre>
          <p className="mt-1 text-muted-foreground">
            Use <code>HARNESS_PROVIDERS=demo</code> for a model-free
            connectivity check. The worker runs in the foreground; closing its
            terminal stops it. A systemd/launchd service can keep it running
            later.
          </p>
        </li>
        <li>
          <strong>Connect a browser on this machine, if needed.</strong>{" "}
          Patchright is the Playwright-compatible automation driver. To reuse
          this machine’s signed-in Chrome profile, it connects through the Meta
          Harness Browser extension. Pair it once so later connections do not
          require Chrome’s remote-debugging approval dialog. Agent work opens
          background tabs using that profile’s existing logins.
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>
              Build the extension in this checkout:
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
                {"pnpm --filter @harness/browser-extension build"}
              </pre>
            </li>
            <li>
              In the Chrome profile you want to share, open{" "}
              <code>chrome://extensions</code>, enable Developer mode, choose
              Load unpacked, and select <code>apps/browser-extension/dist</code>{" "}
              from this checkout.
            </li>
            <li>
              Start the worker with{" "}
              <code>HARNESS_BROWSER_BACKEND=extension</code> added to the
              command above. In another terminal on the same machine, run:
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
                {
                  "HARNESS_WORKER_TOKEN_FILE=~/.config/meta-harness/worker.json pnpm browser:pair"
                }
              </pre>
              Use the same worker credential and any custom data-directory or
              browser configuration environment variables as the running worker.
              For the local worker started with <code>pnpm dev</code> or{" "}
              <code>pnpm start</code>, use <code>pnpm browser:pair</code> alone.
            </li>
            <li>
              Open the Meta Harness Browser extension icon, paste the code
              printed in your terminal, and choose Connect. Keep the code out of
              chat and git. Pairing survives browser and worker reconnects.
            </li>
          </ol>
          <p className="mt-2 text-muted-foreground">
            A Pi or Sandbox can instead use a separate managed browser through
            Patchright. It retains its own logins; it does not automatically
            inherit this Chrome profile’s accounts. Browser pairing is separate
            from worker enrollment, and a worker can run agents without hosting
            a browser.
          </p>
        </li>
        <li>
          <strong>Verify Online below.</strong> Look for its provider/capacity
          report on Tasks, then submit a small test. If offline, check the
          control URL, private-network connectivity, clock and credential. For
          updates, stop this worker, run <code>git pull</code> and{" "}
          <code>pnpm install</code>, then start it again. Revoke a lost
          credential here and enroll a replacement.
        </li>
      </ol>
    </div>
  );
}
