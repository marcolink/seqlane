# Seqlane

Seqlane is a TypeScript workflow foundation for typed plans and isolated
execution.

Workflow authors define tasks with Seqlane contracts. The runtime builds and
executes a serializable Plan. The CLI runs each workflow in a dedicated child
process. The local Studio shows live, read-only execution data.

## Project status

This repository is a foundation-only monorepo. It uses pnpm and Nx. Breaking
changes are allowed while the contracts and package boundaries evolve.

## Quickstart

### Install and build

Use Node.js 24 or later and pnpm 10.33 or later.

```sh
pnpm install --frozen-lockfile
pnpm build
```

### Run a workflow

Start a Seqlane-compatible runtime service first. The `--runtime` value is
the runtime profile used by the runner.

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096
```

The repository entrypoint uses the direct Node command above. A packaged CLI
exposes the same command as `seqlane`.

### Start the local Studio

Start Studio in one terminal:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio \
  --port 57694
```

Open the browser URL printed by Studio. In a second terminal, select that
Studio session for a run:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --studio
```

Studio binds to loopback and keeps run data in memory. Stopping Studio erases
the current run list and event buffer. Direct browser access is intentional for
local development. `seqlane run --studio` stops only a temporary Studio it
starts.

## Development commands

`pnpm test` runs the test-to-implementation mapping check before the Nx test
targets.

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
```

Run a target for one package with Nx. For example:

```sh
pnpm exec nx test seqlane-core
pnpm exec nx lint seqlane-studio
```

Normal tests run directly from source and do not build first. Run the
child-process CLI boundary tests separately when compiled packages are needed:

```sh
pnpm exec nx test:e2e seqlane-cli
```

GitHub Actions runs affected lint and unit-test targets for pull requests and
pushes to `main`. The test workflow always checks test-to-implementation
mappings before it runs affected unit tests.

## Package map

| Package                                                             | Purpose                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@seqlane/core`](libs/seqlane-core/README.md)         | Public Seqlane contracts, task definitions, Flow DSL, and Plan IR.  |
| [`examples/`](examples/README.md)                                  | Runnable local workflow examples.                                    |
| [`@seqlane/fixtures`](libs/seqlane-fixtures/README.md) | Private workflows and schemas for tests.                             |
| [`@seqlane/runtime`](libs/seqlane-runtime/README.md)   | Private Plan compiler, Effect-based runner, and execution context.   |
| [`@seqlane/opencode`](libs/seqlane-opencode/README.md) | Private OpenCode adapter for agent execution.                        |
| [`@seqlane/events`](libs/seqlane-events/README.md)     | Public canonical serialized execution-event contracts and consumers. |
| [`@seqlane/output`](libs/seqlane-output/README.md)     | Human, CI, and JSON renderers for canonical execution events.        |
| [`@seqlane/studio`](libs/seqlane-studio/README.md)     | Private local Studio service, registry, protocol, and SSE transport. |
| [`seqlane`](apps/seqlane-cli/README.md)           | Foreground workflow runner and Studio commands.                      |
| [`@seqlane/studio-app`](apps/seqlane-studio/README.md) | Private React browser client for read-only Studio inspection.        |

## Package boundaries

- Keep Effect types and dependencies inside `seqlane-runtime`.
- Keep executor implementations out of core contracts, Plans, workflow APIs,
  runner IPC, and CLI configuration.
- Use package exports and declared dependencies across package boundaries.
- Keep `seqlane-core` independent of Effect.
- Keep Studio loopback-only, read-only, and transient.

## Documentation

- [`docs/README.md`](docs/README.md) — architecture documents and their order.
- [`docs/ADR-013-local-read-only-execution-studio.md`](docs/ADR-013-local-read-only-execution-studio.md) — Studio decision.
- [`docs/TS-013-local-read-only-execution-studio.md`](docs/TS-013-local-read-only-execution-studio.md) — Studio specification.
- [`docs/ADR-014-local-development-studio-trust-and-lifecycle.md`](docs/ADR-014-local-development-studio-trust-and-lifecycle.md) — local Studio trust and lifecycle decision.
- [`docs/TS-014-local-development-studio-trust-and-lifecycle.md`](docs/TS-014-local-development-studio-trust-and-lifecycle.md) — local Studio access and lifecycle specification.
- [`docs/ADR-015-semantic-validation-gates.md`](docs/ADR-015-semantic-validation-gates.md) — semantic validation gate decision.
- [`docs/TS-015-semantic-validation-gates.md`](docs/TS-015-semantic-validation-gates.md) — semantic validation gate specification.
- [`docs/ADR-016-consumer-agnostic-seqlane-execution-events.md`](docs/ADR-016-consumer-agnostic-seqlane-execution-events.md) — canonical execution-event contract decision.
- [`docs/TS-016-consumer-agnostic-seqlane-execution-events.md`](docs/TS-016-consumer-agnostic-seqlane-execution-events.md) — canonical execution-event contract specification.
- [`AGENTS.md`](AGENTS.md) — repository instructions for agents and contributors.
