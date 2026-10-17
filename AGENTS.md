# Meta Harness

Use pnpm, TypeScript, and the existing Turborepo packages. Read `README.md` and
`docs/architecture.md` before changing orchestration or provider behavior.

- Keep Workflow directives and SDK imports in `apps/web`. Ordinary business
  functions and runtime adapters must remain engine-independent.
- `packages/core` must not import Node, storage, provider implementations, or SDKs.
- Keep idle memory small. Do not add daemon services, package watchers, browser
  processes, or warm agent processes without a concrete need.
- Concurrency settings apply only to this harness; do not change machine-wide
  resource limits or terminate unrelated processes.
- Interrupted native agent execution must not be retried automatically.
- Run `pnpm check`, `pnpm test`, and `pnpm build`. For execution changes, run
  `pnpm smoke` against the local stack. Provider tests should use fixtures unless
  live model calls are needed and intentionally selected.
- Eve is an architectural reference. It is not a runtime dependency. Document
  changes to that decision and preserve the engine boundary.
