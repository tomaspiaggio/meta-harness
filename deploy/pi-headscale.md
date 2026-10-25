# Move the control plane to the Pi with Google sign-in

This runbook prepares deployment; it does not claim the Pi has been migrated.
Keep existing application data and credentials. Do not start a second control
plane against the same database or delete/reseed an existing installation.

## Name and HTTPS first

MagicDNS resolves names. It does not automatically issue a certificate for a
Headscale service. The Pi already advertises its node name; add an app-specific
A/AAAA record through Headscale `dns.extra_records` or `dns.extra_records_path`.
Use a real owned domain such as `harness.example.com` pointing to the Pi's actual
tailnet IP. The name can remain resolvable only inside the tailnet.

Google's production OAuth redirect hostname must use a public DNS suffix.
`server.tomhom`/`macbook.tomhom` therefore are not appropriate production callback
names. `localhost` is the documented development exception.

Recommended path: browser/worker -> tailnet -> Caddy HTTPS -> harness gateway ->
private Next.js/Workflow port. Do not point Caddy straight at the private Next.js
port or expose Workflow control routes. Restrict access to tailnet clients.

For a publicly trusted certificate without opening the service to the Internet,
use ACME DNS-01 with the DNS provider for your owned domain. Caddy needs the
matching DNS provider module and a narrowly scoped DNS API credential. A public
certificate exposes its hostname in Certificate Transparency; it does not expose
the service. Keep private keys/DNS credentials outside git. A private CA is an
alternative for trusted devices, but it does not remove Google's hostname rules.

Example Headscale configuration (apply on the actual Headscale server, matching
its installed version; replace values):

```yaml
dns:
  magic_dns: true
  base_domain: tomhom
  extra_records:
    - name: harness.example.com
      type: A
      value: 100.PI.TAILNET.IP
```

Preserve the existing Headscale DNS configuration rather than replacing it. The
static option requires a Headscale restart; `extra_records_path` is watched.
DNS name registration is configuration, not mDNS/Bonjour service discovery.

Example Caddy site with a Cloudflare DNS module (only if Cloudflare hosts this
zone; choose your actual provider/module otherwise):

```caddyfile
harness.example.com {
    bind 100.PI.TAILNET.IP
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:3000
}
```

Configure the Caddy service with persistent certificate storage and its DNS
credential. No public HTTP port forwarding is needed for DNS-01. A standard Caddy
binary may not include the DNS module: validate with `caddy list-modules`.

## Google OAuth client

In Google Cloud Console:

1. Create/select a project and configure Google Auth Platform branding/audience.
   For a personal Gmail account, use External; in testing add
   `tomas.piaggio12@gmail.com` as a test user.
2. Create an OAuth client of type Web application.
3. Add the exact authorized redirect URI:
   `https://harness.example.com/api/auth/callback/google`.
4. For local development, optionally add
   `http://localhost:3000/api/auth/callback/google` as a separate URI.
5. Store Client ID and Client Secret in the Pi's private environment file.
   Do not send the secret in a chat or put it in a repository.

The application's verified-email allowlist is enforced independently of Google's
test-user list. Only `tomas.piaggio12@gmail.com` should be configured initially.

## Prepare the Pi without starting control

Use Node 24+, pnpm 10.10.0 and the reviewed release containing Google auth. Keep
using the existing Pi worker's OS account so its provider authentication remains
available. From its checkout, install and build with low concurrency:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Choose a persistent local SSD-backed data directory, for example
`~/.local/state/meta-harness/control`. Keep the execution worker's existing data
and credential directories separate. Do not run the new control service yet:
starting it against an empty destination seeds a different installation.

## Migrate the existing control state

1. Finish or explicitly stop active turns; pause scheduling/dispatch during the
   maintenance window. Record the existing workers, session IDs and schedules.
2. Stop the Mac control launcher. Do not copy a live SQLite DB or live Workflow
   storage as ordinary files. Keep an off-device backup before changing anything.
3. With control stopped, copy the **entire control data directory** to a private
   staging directory on the Pi using secure transfer. Include the SQLite database
   and any WAL/SHM sidecars, `workflow/`, local objects/attachments/checkpoints,
   encryption key, grant key and retained local configuration as applicable.
   Copy from a quiescent directory; do not use `rsync --delete` or overwrite a
   populated destination. Preserve Mac data as the rollback copy.
4. Verify hashes and ownership, then use the staged copy as the Pi control data
   directory. Keep provider credentials and worker execution caches on their
   original hosts; they are not made portable by copying the control database.
5. Preserve environment-supplied encryption/grant/auth secrets too. Check both
   the existing private `.env` and file-backed keys; a DB backup alone is not
   sufficient for encrypted browser/object recovery.
6. Start only the Pi control plane. Confirm the original sessions, schedules,
   decisions and attachments exist before allowing workers to claim new turns.

A cold copy preserves the local Workflow world's pending timers/history, but that
backend remains a local-development backend, not a production HA guarantee.
Before relying on unattended schedules, test restart/recovery on the Pi and keep
backups. PostgreSQL migration can be a separate operation; Google auth does not
force it. Use `pnpm db:transfer` and its restore rehearsal if choosing PostgreSQL.

## Pi control environment

Create a mode-600 environment file, e.g.
`~/.config/meta-harness/control.env`, using actual absolute paths:

```dotenv
HARNESS_DATA_DIR=/home/tomaspiaggio/.local/state/meta-harness/control
HARNESS_BIND_HOST=127.0.0.1
HARNESS_REQUIRE_AUTH=1
PORT=3000
WORKFLOW_TARGET_WORLD=local
HARNESS_AUTH=google
HARNESS_PUBLIC_URL=https://harness.example.com
HARNESS_OWNER_EMAILS=tomas.piaggio12@gmail.com
GOOGLE_CLIENT_ID=<Google OAuth web client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
BETTER_AUTH_SECRET=<32+ random characters generated locally>
```

Generate and retain the Better Auth secret privately; reuse it on restart. Copy
any environment-supplied existing encryption/grant/object-store settings here as
well. Do not set `HARNESS_HOSTED=1` for this local Pi profile: that separate profile
requires PostgreSQL and hosted orchestration configuration.

Google mode disables legacy access-token login and owner-token API access. Worker
credentials remain independent and keep working. Do not enable Google mode before
its origin, OAuth credentials and email allowlist are complete. The config fails
closed when required settings are missing. Keep the existing local deployment
usable until the replacement is verified.

## systemd startup

Use a user service for the existing Pi user. Get the actual Node 24 executable
with `command -v node` and the absolute checkout path. Create
`~/.config/systemd/user/meta-harness-control.service`:

```ini
[Unit]
Description=Meta Harness control plane
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/meta-harness
EnvironmentFile=%h/.config/meta-harness/control.env
ExecStart=/absolute/path/to/node scripts/dev.mjs --production --control-only
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Use absolute Node and checkout paths; a service does not load your interactive
shell's Node version manager. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now meta-harness-control.service
systemctl --user status meta-harness-control.service
journalctl --user -u meta-harness-control.service -f
```

For startup without an interactive login, enable lingering once:

```sh
sudo loginctl enable-linger tomaspiaggio
```

Keep the existing Pi execution worker as a separate service. This control service
starts no worker, browser or model process. Caddy should also start on boot.

## Reconnect workers and verify

Use `HARNESS_CONTROL_URL=https://harness.example.com` on each existing worker;
retain its worker credential and data directory. The copied control database
retains their token hashes, so do not reenroll every device. Remove the temporary
`HARNESS_ALLOW_INSECURE_HTTP=1` override once workers use HTTPS.

For the Mac, run a standalone worker against the Pi instead of starting another
Mac control plane. Reuse its original worker ID/credential/cache so existing
machine-local native sessions and browser pairing retain their identity.

Verify, in order:

- Domain resolves to the Pi tailnet address on Mac, Pi and phone; HTTPS validates.
- Unauthenticated application APIs return 401; internal Workflow routes return
  404 through Caddy/the public gateway.
- Continue with Google accepts the allowed verified account and rejects others.
  Sign out invalidates the session immediately; old token login cannot bypass it.
- Original data is present. Existing workers report Online with the original IDs.
- A harmless Codex task runs on the Pi; a browser task can still use the Mac host.
- Closing the UI tab does not stop work; restarting the control service preserves
  history and schedules. Reboot the Pi and repeat these checks.

Moving control state does not guarantee native provider migration or repository
handoff. Keep existing native conversations on their original worker until that
provider's checkpoint can be restored. Uncommitted repository work needs a
consistent dirty-file checkpoint or worker affinity; a clean commit must also be
pushed/bundled before another worker can fetch it. Those implementation gates are
tracked separately in docs/implementation-checklist.md.

## Later installer

A future `npx meta-harness install <enrollment-token>` should redeem a short-lived,
one-use bootstrap code for the actual per-device credential. Do not use a long-lived
worker token as a command-line argument: it can land in shell history/process lists.
The CLI can install dependencies, write a private config, register a user service,
verify connectivity, and guide provider/browser login. Keep the same service and
worker entrypoints underneath it. Release packaging and code redemption are future
work; the current copied setup prompt remains supported.

Sources: https://headscale.net/stable/ref/dns/ ;
https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri-validation ;
https://better-auth.com/docs/authentication/google ;
https://caddyserver.com/docs/automatic-https#dns-challenge

## Encrypted backups

`scripts/backup.mjs` runs hourly from a user timer (`meta-harness-backup.timer`).
It snapshots SQLite with `VACUUM INTO` while control runs, adds `workflow/`,
`objects/`, `encryption-key`, `admin-token` and the files listed in
`HARNESS_BACKUP_EXTRA` (the control env with its auth secret), encrypts the
bundle to the owner's public key and uploads it with rclone (Drive scope
`drive.file`). The control host cannot decrypt its own backups; the private key
is kept by the owner. Retention: hourly for 2 days, daily for 30 days, weekly
for 26 weeks. Settings → Backups shows the last run; failures and 3 missed
hours send a push notification.

Restore on a stopped control host:

```sh
gpg --import meta-harness-backup-private.asc
rclone copy "drive:Meta Harness backups/<file>" .
gpg --output control.tar.gz --decrypt <file>
tar -xzf control.tar.gz   # control/ is the data directory; extra/ holds env files
```
