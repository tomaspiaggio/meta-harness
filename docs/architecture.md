# Local architecture and the Eve reference

Decision date: 2026-10-16. The initial engine is Vercel Workflow; engine migration
is a design constraint, not a reason to build a second orchestration framework.

## Separate transport, orchestration, and execution

[Eve's internal architecture](https://github.com/vercel/eve/blob/main/packages/eve/README.md#architecture-internals)
separates channels, harness execution, and durable runtime responsibilities. Our
corresponding boundaries are HTTP/UI, the runtime adapters and application
functions, and the Workflow composition root. Eve also keeps the sandbox and
durable conversation lifetimes independent. We borrow that principle: an idle
session is a record, not a resident process.

```mermaid
flowchart LR
    UI[Next.js UI / HTTP] --> DB[(SQLite: application state + outbox)]
    UI --> WF[Workflow adapter]
    WF --> STEP[Thin steps]
    STEP --> CORE[Ordinary application functions]
    CORE --> DB
    DB --> WORKER[Local worker / ownership lease]
    WORKER --> EXEC[executeTurn]
    EXEC --> RT[AgentRuntime port]
    RT --> CLI[Demo / Claude CLI / Codex CLI]
    EXEC --> DB
```

No SDK types, directives, or implicit workflow context enter `packages/core`,
`packages/storage`, or `packages/runtimes`. Workflow IDs are optional correlation
references on a turn, not session identities. Checkpoints and arguments must be
plain serializable values. Processes, database connections, and credentials are
constructed at the execution boundary, never passed through workflow history.

Eve also emphasizes human-readable instructions and capabilities authored on disk.
We should adopt Markdown workspace instructions and skills when adding the
knowledge repository. The current local slice stores workspace instructions in
SQLite; this is explicitly not yet the git-backed configuration ingestion design.

## Borrow patterns before adopting the whole framework

[Eve's execution model](https://github.com/vercel/eve/blob/main/docs/concepts/execution-model-and-durability.mdx)
owns the model/tool loop and checkpoints steps within turns. A native Codex/Claude
process owns its own loop. Wrapping that process in a Workflow step would not make
its individual tool calls replay-safe. Our workflow only dispatches and observes
the local job; the worker owns provider execution. An interruption is surfaced
rather than automatically repeating unknown effects.

Eve's [proposal to decouple its loop from durable orchestration](https://github.com/vercel/eve/issues/512)
is a useful reference for this boundary. It is a proposal, not a guarantee about
the current implementation. We do not copy its internal APIs or add an Eve runtime
dependency to this slice. Evaluate an Eve-backed agent as another runtime adapter
when we want a custom model/tool loop, or use Eve more directly if that becomes
the primary product direction.

Patterns to retain:

- Session identity is independent of transport, provider-native ID, and workflow run.
- Compute can stop while the conversation remains available.
- Skills are optional context, tools are executable functions, and transports own
  request authentication rather than delegating it to instructions.
- Waiting for a human eventually becomes a durable waiting state, rather than a
  provider process kept alive indefinitely.

## Why a workflow per turn here

The original design and Eve use long-lived session workflows. This local slice
uses a workflow per turn, with session serialization enforced transactionally by
the application. It keeps engine history bounded by one turn, allows new code
for subsequent turns, and avoids making the application session dependent on a
particular orchestration run. Native provider state survives between processes.

This does not yet implement input queues, steering, approval requests, or durable
timers spanning turns. Revisit a session coordinator when those requirements
arrive, while retaining application-owned session identity.

## Migration and deployment

Workflow's [Postgres World](https://workflow-sdk.dev/worlds/postgres) is another
self-hosted option for the Pi: Postgres backs workflow state and Graphile Worker
processes queued work in a long-lived process. It is distinct from the managed
Vercel World used on Vercel. The local development path does not require Postgres;
adding that backend later requires compatible package versions, schema bootstrap,
startup wiring, and an explicit restart/replay test. It does not itself replace
the application's separate SQLite persistence adapter or worker protocol.

Build/debug acceptance gates are part of choosing the engine: a clean build,
an incremental build, a cache-hit build, a real local workflow/worker smoke test,
restart with an accepted pending turn, and inspection of its actual run records.
Eve remains a separate evaluation so bundler and runtime failures can be isolated
before adding another framework layer.

For Temporal, create TypeScript workflow/activity wrappers around `enqueueTurn`
and `readTurnOutcome`, or use Temporal activity workers to execute `executeTurn`.
Keep stable turn IDs, ownership fencing, and idempotency in application storage.
Activity retries must never blindly rerun native agent work. Translate engine
timeouts/cancellation explicitly, drain existing runs or import application
checkpoints, and test those semantics; replacing imports alone is insufficient.

For hosted Vercel, replace local SQLite with networked persistence, replace the
local-only outbox timer with durable hosted dispatch, enroll remote workers over
an authenticated API, and use hooks for prompt completion notification plus
reconciliation. Local CLI credentials stay on workers. A hosted function cannot
read this machine's SQLite database or local provider session store.

## What remains to validate

Actual provider subscription authentication, live continuation, checkpoint
portability, browser state, ARM64 hosts, and hosted network connectivity need
their own compatibility spikes. This slice does not imply those guarantees.
