# Restoring Meta Harness

How to bring the control plane back after something breaks, from a stuck
service up to a dead Raspberry Pi. Read the first section, then follow only the
scenario that applies.

## What is backed up, and what you need

Every hour the control host uploads one encrypted file to Google Drive, in the
folder **Meta Harness backups**. Files are named
`meta-harness-YYYYMMDDTHHMMZ.tar.gz.gpg` (UTC time). Kept: hourly for 2 days,
daily for 30 days, weekly for 26 weeks.

Each file contains `control/`, a complete control data directory:

| Path in the backup | What it is |
| --- | --- |
| `control/harness.sqlite` | The database: workspaces, sessions, turns, schedules, decisions, workers, settings |
| `control/workflow/` | Workflow engine state (runs, timers) |
| `control/objects/` | Uploaded files and attachments |
| `control/encryption-key` | Decrypts stored credentials (Google, MCP, secrets); without it they are unreadable |
| `control/admin-token` | Local admin login token |
| `control/google-resource-client.json` | Google resource OAuth client, if configured |
| `control/extra/control.env` | The control service settings, including the sign-in secret and Google client |

Not in the backup, so redo by hand after a full rebuild: worker machines'
own state (enrollment file, browser profiles, caches), agent CLI logins (Claude,
Codex), and Caddy/Headscale configuration.

You need:

- **The private key**: Dashlane → secure note **Meta Harness Backup Key**. It is
  the only way to open a backup. Nobody else has a copy.
- **A backup file**: download it at drive.google.com → Meta Harness backups (pick
  the newest unless you are going back to before a problem).
- This repository: `https://github.com/tomaspiaggio/meta-harness`.

At most the last hour of activity is lost when restoring from Drive.

Never run two control planes against copies of the same data. If the old host
might come back, keep it switched off (or its control service stopped) until
you are done.

## Which scenario?

| Symptom | Go to |
| --- | --- |
| App doesn't load, but the Pi is up and you can SSH in | [1. Service won't start](#1-service-wont-start) |
| App loads but data is wrong, missing or the database is corrupt | [2. Restore data on the same host](#2-restore-data-on-the-same-host) |
| Pi is dead, SD card failed, or you are moving to a new machine | [3. Rebuild on a new host](#3-rebuild-on-a-new-host) |

Paths below are the Pi's defaults (`~` is the service user's home):

- releases: `~/.local/share/meta-harness/releases/<commit>`
- data: `~/.local/state/meta-harness/control`
- settings: `~/.config/meta-harness/` (`control.env`, `worker.env`, `backup.env`)
- services: `~/.config/systemd/user/meta-harness-{control,worker,backup}.*`
- deployment record: `~/.local/state/meta-harness/current-deployment.json`

## 1. Service won't start

Nothing is restored here; data stays as it is.

```sh
systemctl --user status meta-harness-control meta-harness-worker
journalctl --user -u meta-harness-control -n 100 --no-pager
curl -s http://127.0.0.1:3000/api/version     # the running commit
```

Common causes:

- **Bad release.** Point the units back at the previous release (listed under
  `previous` in `current-deployment.json`; older ones stay in `releases/`):

  ```sh
  R=~/.local/share/meta-harness/releases/<previous-commit>
  cd ~/.config/systemd/user
  sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$R#" meta-harness-control.service meta-harness-backup.service
  sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$R/apps/worker#" meta-harness-worker.service
  systemctl --user daemon-reload
  systemctl --user restart meta-harness-control meta-harness-worker
  ```

  Only roll back code across a release that changed the database schema if the
  older code still starts; otherwise fix forward.
- **Services not running after a reboot.** User services need lingering:
  `loginctl show-user $USER -p Linger` must say `yes`
  (`sudo loginctl enable-linger $USER`), and the units must be enabled:
  `systemctl --user enable --now meta-harness-control meta-harness-worker meta-harness-backup.timer`.
- **Disk full.** `df -h ~`; remove old `releases/` worktrees with
  `git -C ~/meta-harness worktree remove <path>` (never the current one).
- **Interrupted agent turns** are not retried automatically. Resend them from
  the app.

## 2. Restore data on the same host

Use this when the database is damaged or you need to go back in time.

1. Download the backup from Drive to the Pi (or download it in a browser and
   `scp` it over).

2. Put the private key in a file. On the machine where you will decrypt:

   ```sh
   umask 077
   pbpaste > ~/meta-harness-backup-private.asc   # macOS; or paste into an editor
   gpg --import ~/meta-harness-backup-private.asc
   ```

   If you decrypt on a laptop instead of the Pi, copy the resulting
   `control/` folder to the Pi afterwards. The key never needs to be on the Pi.

3. Decrypt and unpack:

   ```sh
   mkdir -p ~/restore && cd ~/restore
   gpg --output control.tar.gz --decrypt ~/meta-harness-YYYYMMDDTHHMMZ.tar.gz.gpg
   tar -xzf control.tar.gz
   ls control    # harness.sqlite, workflow, objects, encryption-key, extra, ...
   ```

4. Stop the services, set the current data aside (do not delete it), and move
   the restored data in:

   ```sh
   systemctl --user stop meta-harness-backup.timer meta-harness-worker meta-harness-control
   S=~/.local/state/meta-harness
   mv $S/control $S/control.broken-$(date +%Y%m%d-%H%M)
   mv ~/restore/control/extra ~/restore/extra
   mv ~/restore/control $S/control
   chmod 700 $S/control
   ```

   `~/restore/extra/control.env` only matters if `~/.config/meta-harness/control.env`
   was lost too; then copy it there and check `HARNESS_DATA_DIR` in it.

5. Start and check:

   ```sh
   systemctl --user start meta-harness-control
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login   # 200
   systemctl --user start meta-harness-worker meta-harness-backup.timer
   ```

   Sign in, open a recent session, and check Settings → Workers shows the
   workers online.

6. Remove the plaintext copies: `rm -rf ~/restore ~/meta-harness-backup-private.asc`
   and `gpg --delete-secret-keys "Meta Harness backups"` on any machine that is
   not your own laptop.

## 3. Rebuild on a new host

For a dead Pi or a new machine. Linux (Debian/Raspberry Pi OS) with systemd is
assumed; the user running it is called the service user below.

### 3.1 Base software

```sh
sudo apt-get update
sudo apt-get install -y git curl gnupg build-essential python3
# Node.js 24 (from nodejs.org or NodeSource), then pnpm 10.10.0:
node --version                     # must be v24 or newer
sudo corepack enable && corepack prepare pnpm@10.10.0 --activate
sudo loginctl enable-linger $USER  # user services start at boot
```

Chromium is needed only if this host also runs a worker with a browser:
`sudo apt-get install -y chromium`.

### 3.2 Code

```sh
git clone https://github.com/tomaspiaggio/meta-harness.git ~/meta-harness
C=<commit>   # the release you want; the newest main or the last deployed one
mkdir -p ~/.local/share/meta-harness/releases
git -C ~/meta-harness worktree add --detach ~/.local/share/meta-harness/releases/$C $C
cd ~/.local/share/meta-harness/releases/$C
pnpm install --frozen-lockfile
pnpm build
```

On a Raspberry Pi, prefix the last two with `nice -n 15 ionice -c 3`.

### 3.3 Data

Decrypt the backup as in [scenario 2](#2-restore-data-on-the-same-host),
steps 2–3, then:

```sh
mkdir -p ~/.local/state/meta-harness ~/.config/meta-harness
chmod 700 ~/.local/state/meta-harness ~/.config/meta-harness
mv ~/restore/control ~/.local/state/meta-harness/control
mv ~/.local/state/meta-harness/control/extra/control.env ~/.config/meta-harness/control.env
rmdir ~/.local/state/meta-harness/control/extra
chmod 600 ~/.config/meta-harness/control.env
```

Open `~/.config/meta-harness/control.env` and check:

- `HARNESS_DATA_DIR` is `/home/<service user>/.local/state/meta-harness/control`.
- `HARNESS_PUBLIC_URL` is the address you will open in the browser. If it
  changes, add `<new URL>/api/auth/callback/google` to the OAuth client's
  authorized redirect URIs in Google Cloud Console, or Google sign-in fails.
- `HARNESS_BIND_HOST=0.0.0.0` and `PORT=3000`.

### 3.4 Control service

`~/.config/systemd/user/meta-harness-control.service`:

```ini
[Unit]
Description=Meta Harness control plane
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<service user>/.local/share/meta-harness/releases/<commit>
EnvironmentFile=%h/.config/meta-harness/control.env
ExecStart=/usr/bin/node scripts/dev.mjs --production --control-only
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
Nice=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now meta-harness-control
curl -s http://127.0.0.1:3000/api/version
```

### 3.5 Network and HTTPS

The app is reached only through the tailnet, behind Caddy. Follow
[`deploy/pi-headscale.md`](../deploy/pi-headscale.md):

- Caddy site for the app's hostname, proxying to `127.0.0.1:3000`, limited to
  tailnet and loopback clients, with a trusted certificate.
- The Headscale DNS record for that hostname pointing at the new host's
  tailnet IP. If the hostname stays the same, existing workers and phones need
  no changes.

Check from a tailnet device: the login page loads over HTTPS without a
certificate warning, and Google sign-in completes.

### 3.6 Workers

Workers keep their own enrollment and are still listed in the restored
database.

- **A worker on another machine (e.g. the Mac)** keeps working if the app's
  hostname is unchanged. If it changed, set `HARNESS_CONTROL_URL` in that
  worker's env file and restart it.
- **A worker that ran on the dead host** is gone with its enrollment, browser
  profiles and agent logins. In the app, Settings → Workers: revoke the old
  entry, add a new worker, and follow the generated setup on the new host. Then
  log in to the agent CLIs (`claude`, `codex`) on it again, and sign in again
  to sites in its managed browser.

### 3.7 Backups again

The new host must start backing up again. Settings → Backups shows
"not set up" until it does.

1. Public key: export it from the private key on your laptop
   (`gpg --armor --export "Meta Harness backups" > backup-public.asc`) and copy it to
   `~/.config/meta-harness/backup-public.asc` (mode 600).
2. rclone: install the standalone binary from https://rclone.org/downloads/
   into `~/.local/bin/rclone` and verify its checksum. Create the Drive remote on
   a machine with a browser, then copy the config file over:

   ```sh
   rclone config create drive drive scope=drive.file --config ./rclone.conf
   scp ./rclone.conf <host>:.config/meta-harness/rclone.conf && rm ./rclone.conf
   ```

   The `drive.file` scope only shows rclone the files created through the same
   OAuth client. If the client changed, rclone cannot see or prune the old
   folder; rename the old folder in Drive first so new backups start a fresh
   one and the old ones stay untouched.
3. `~/.config/meta-harness/backup.env` (mode 600):

   ```sh
   HARNESS_DATA_DIR=/home/<service user>/.local/state/meta-harness/control
   HARNESS_BACKUP_KEY=/home/<service user>/.config/meta-harness/backup-public.asc
   HARNESS_BACKUP_REMOTE=drive:Meta Harness backups
   HARNESS_BACKUP_RCLONE=/home/<service user>/.local/bin/rclone
   HARNESS_BACKUP_EXTRA=/home/<service user>/.config/meta-harness/control.env
   RCLONE_CONFIG=/home/<service user>/.config/meta-harness/rclone.conf
   ```

4. Units, `~/.config/systemd/user/meta-harness-backup.service`:

   ```ini
   [Unit]
   Description=Meta Harness encrypted backup to Drive

   [Service]
   Type=oneshot
   WorkingDirectory=/home/<service user>/.local/share/meta-harness/releases/<commit>
   EnvironmentFile=/home/<service user>/.config/meta-harness/backup.env
   ExecStart=/usr/bin/node scripts/backup.mjs
   Nice=15
   IOSchedulingClass=idle
   ```

   and `meta-harness-backup.timer`:

   ```ini
   [Unit]
   Description=Hourly Meta Harness backup

   [Timer]
   OnCalendar=hourly
   RandomizedDelaySec=300
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now meta-harness-backup.timer
   systemctl --user start meta-harness-backup.service
   journalctl --user -u meta-harness-backup -n 5 --no-pager   # "Backed up meta-harness-…"
   ```

### 3.8 Final checks

- Sign in; workspaces, sessions and schedules are there.
- Settings → Workers: workers online.
- Settings → Integrations: Google and MCP connections still work (this
  confirms the encryption key was restored).
- Settings → Notifications: "Send a test". Phones may need to turn
  notifications on again if the app's address changed.
- Settings → Backups: a backup in the last hour.
- Keep the old SD card or data untouched until everything above passes.

## Testing a backup without touching anything

To check a backup opens, on your laptop:

```sh
gpg --output c.tar.gz --decrypt meta-harness-….tar.gz.gpg && tar -tzf c.tar.gz | head
```

A list starting with `control/` means the key and the file are good. Delete
the decrypted copy afterwards.
