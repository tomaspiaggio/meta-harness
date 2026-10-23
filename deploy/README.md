# Private deployment preparation

No service has been installed on the Pi or Jetson. These templates are inputs to
a deployment after SSH access and actual hardware compatibility are established.
Node must be **24+**; update `/usr/bin/node` to its actual installed location.
Do not install the control service on the Mac if tasks must survive closing it.

## Control host (Pi or another always-on machine)

1. Install the repository under `/opt/meta-harness`, run `pnpm install
   --frozen-lockfile`, and `pnpm build`.
2. Create a dedicated `meta-harness` OS user and a persistent, SSD-backed
   `/var/lib/meta-harness` directory owned by that user.
3. Put control settings in `/etc/meta-harness/control.env`:

   ```dotenv
   HARNESS_DATA_DIR=/var/lib/meta-harness
   HARNESS_BIND_HOST=100.your.tailnet.ip
   PORT=3000
   WORKFLOW_TARGET_WORLD=local
   ```

4. Install `systemd/meta-harness-control.service` with the correct paths and user.
   Start it through the service manager. This starts no agent worker.
5. Terminate HTTPS through your tailnet reverse proxy. The launcher exposes a
   public gateway and keeps Next.js/Workflow callbacks on a separate loopback
   port. The gateway allows only the UI and application/worker APIs; generated
   Workflow routes are not exposed.
6. Read `/var/lib/meta-harness/admin-token` locally on the control host, then use
   `/login` from your phone. Never put that token in a URL or source control.
7. Enroll one credential per worker using `pnpm worker:enroll` on the control host.

`WORKFLOW_TARGET_WORLD=local` is deliberately the development/test profile. Before
relying on the service for production, configure and test a supported persistent
Workflow backend, off-device database backups, and restoration. The application's
SQLite file is central and must never be shared/mounted across workers.

## Execution host (Mac, Pi, or Jetson)

Install the same pinned release with Node 24 and pnpm. Transfer its enrolled
credential file securely outside session execution directories. Worker settings:

```dotenv
HARNESS_WORKER_TOKEN_FILE=/etc/meta-harness/worker.json
HARNESS_WORKER_DATA_DIR=/var/lib/meta-harness-worker
HARNESS_PROVIDERS=demo
HARNESS_CONCURRENCY=1
HARNESS_MEMORY_BUDGET_MIB=2048
HARNESS_MEMORY_RESERVE_MIB=1024
HARNESS_CPU_SLOTS=2
```

Use `systemd/meta-harness-worker.service` on Linux, or `pnpm worker --credential
/path/to/worker.json` in a terminal on the Mac. A launchd service can run that same
worker entrypoint with an absolute Node 24 path when persistent Mac startup is
wanted. No launch agent has been installed automatically.

Start with Demo. Run actual provider authentication as the worker's OS user before
advertising Claude/Codex. Do not copy the Mac's full home or credential directory
to another machine. Native Claude SDK transfer is experimental; the readme lists
its explicit compatibility bench. The worker does not require central SQLite or
Workflow SDK access over the network.

## Acceptance on real hardware

- Create a Demo task from the phone and observe it running on the selected host.
- Drain one host and continue the same conversation on another.
- Terminate a worker mid-Demo turn and verify checkpoint recovery after lease expiry.
- Close the Mac while the control plane remains online; verify phone access and
  continued execution on the always-on host.
- Validate native provider continuation separately, including auth renewal and
  execution-file portability. Demo passing does not establish that guarantee.

## Optional Sandbox execution pool

Sandbox provisioning is implemented behind deployment/workspace opt-in and remains
unexercised against a real cloud account. See [operations](../docs/operations.md)
for snapshot preparation, scoped expiring identities, capacity limits and activation
gates. Nothing has been provisioned or installed on external machines automatically.
The same guide covers Prisma/PostgreSQL, hosted owner authentication, private object
storage, encrypted browser takeover and Telegram setup.
