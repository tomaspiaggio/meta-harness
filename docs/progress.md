# Overnight progress — 2026-10-17

The distributed prototype is implemented and locally tested. Real hardware and
native-provider portability still have explicit acceptance gates. Existing user
workspaces and conversations have not been imported or moved.

## Try it

```sh
pnpm start
```

Open `http://127.0.0.1:3000/tasks`, create a Demo task, and open its attached
conversation. The build is already present. Default admission preserves 1 GiB of
reported free host memory and runs one agent at a time; a busy host can visibly
hold work in the queue. Those defaults affect this harness only.

For the repeatable, isolated handoff trial:

```sh
pnpm bench
```

The bench starts its own temporary control plane and two workers, kills the
first mid-turn, waits through the real 30-second lease expiry, restores the
checkpoint on the second, and tests a subsequent planned transfer back. It uses
Demo, separate execution directories, and no real memory stress or model calls.
Its latest report is `.data/bench/latest.json`; recovery was about 31 seconds.

All test services are stopped after each bench. There are no installed launchd
or systemd services, and no automatic browser or model processes kept warm.

## Review stack

There is no configured git remote, so nothing has been pushed and no PRs have
been opened. The work is committed on these local stacked branches:

| Branch | Base | Change |
| --- | --- | --- |
| `main` | Initial commit | Original local UI, runtime adapters, Workflow composition, persistence, tests |
| `feat/distributed-tasks` | `main` | Durable tasks, priorities, resource admission, scoped HTTP workers, Demo checkpoints, two-worker bench, task/capacity UI |
| `feat/claude-portability` | `feat/distributed-tasks` | Experimental native transcript store, revision/ownership gates, SDK adapter, provider cooldowns, explicit live compatibility bench |
| `feat/control-gateway` | `feat/claude-portability` | Authenticated network surface, hidden Workflow routes, gateway/security tests, deployment templates and these notes |

Useful comparisons:

```sh
git diff main..feat/distributed-tasks
git diff feat/distributed-tasks..feat/claude-portability
git diff feat/claude-portability..feat/control-gateway
```

## Verified

- Formatting, package boundaries, and TypeScript checks pass.
- 28 tests cover scheduling, independent resource slots, scoped credentials,
  idempotency, ownership fencing, native transcript isolation and revision gates,
  provider cooldowns, subprocess termination, snapshot integrity, and the gateway.
- Production build passes; Workflow-generated routes are included in Turbo outputs.
- Existing two-turn smoke and control-process restart recovery pass over HTTP.
- The authenticated network-mode test passes for administrator tokens, cookies,
  cross-origin rejection, worker authentication, hidden engine routes, and private
  Workflow callback dispatch.
- The two-worker distributed Demo bench passes, including an abrupt kill,
  checkpoint/file restoration, old-generation rejection, draining, and continuation.

## External gates

**Claude:** the actual account is signed in, but the live compatibility test hit
its existing provider session limit. Successful native cross-worker continuation
has therefore not been demonstrated. The SDK adapter is opt-in with
`HARNESS_CLAUDE_RUNTIME=sdk`; the default remains CLI. Run `pnpm bench:claude`
when quota is available. That explicit bench makes two small real requests, uses
no tools, and sets a $0.10 SDK budget per turn. It validates remembered context,
the same native session ID, and execution-file restoration on another worker.
Do not interpret Demo recovery as proof of native Claude recovery.

**Pi/Jetson:** a Linux tailnet peer was discoverable, but SSH with the available
local identity was denied. No remote services or credentials were changed.
[Deployment preparation](../deploy/README.md) includes enrollment commands and
Linux service templates; paths, OS user, Node version, and hardware must be checked
before installation.

**Sandbox:** provisioning and live execution are not implemented. The worker
protocol is suitable for an outbound HTTPS worker, but a sandbox needs a reachable
control origin, short-lived enrollment, and an installed pinned worker release.
The Mac's private address is not automatically reachable from Vercel.

**Durability:** the current control plane uses the Workflow local world plus
central application SQLite. Production operation still needs a supported durable
Workflow backend and off-device backup/restore validation. Workers do not share
or mount that SQLite file.

**Side effects:** native turns are never automatically replayed after worker loss.
The optional Claude transfer requires a completed checkpoint with a matching
native transcript revision. Resource scheduling uses reservations and host
measurements; it is not OS-enforced containment of arbitrary build processes.

## Next execution order

1. Pass the opt-in Claude compatibility bench with available quota; fix any actual
   auth/path/resume incompatibility it exposes before enabling the SDK by default.
2. Run the same pinned release on an always-on control host and a second worker.
   Verify phone access and the real close-Mac scenario first with Demo.
3. Configure a production Workflow backend and verify off-device restore.
4. Add Sandbox capacity with an expiring worker identity and a reachable control API.
5. Add tool-operation reconciliation and provider-specific safe suspension before
   promising automatic takeover of arbitrary native turns in mid-execution.
