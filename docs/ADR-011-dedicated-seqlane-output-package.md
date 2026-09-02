# ADR-011 — Isolate Seqlane Execution Output in a Dedicated Package

**Status:** Implemented
**Related:** ADR-002, ADR-007, ADR-008, RFC-002

## Context

Seqlane execution events cross the dedicated runner boundary and are currently
projected directly by the CLI. The CLI will need to support several output
surfaces:

- Human TTY output with live updates, collapsed completed work, nested workflows,
  and parallel task rows.
- Non-interactive CI output with permanent lines, heartbeats, and GitHub Actions
  annotations or summaries.
- Machine-readable JSON or NDJSON output.

Human mode requires renderer-owned state. It must track workflow containment,
dependency relationships, expanded and focused nodes, stable row ordering, and
aggregate progress. This state is a presentation projection, not execution
state.

Keeping this logic in the CLI would make command handling responsible for
terminal rendering and execution-state projection. Putting it in
`seqlane-core` would add terminal concerns to public, executor-neutral
contracts. Putting it in `seqlane-runtime` would couple runtime execution to a
consumer-specific presentation.

## Decision

Seqlane will provide a dedicated private monorepo package for execution output:

```text
libs/seqlane-output
```

The package will consume serializable Seqlane runner events and provide
renderer-facing projections and output renderers. It will initially support
human, CI, and JSON output modes.

The package boundary is:

```text
seqlane-core       canonical event and identity contracts
        ↓
seqlane-runtime   execution and event emission
        ↓
seqlane-output    view-model reducers and output renderers
        ↓
seqlane-cli       flags, mode selection, runner wiring, exit status
```

`seqlane-output` must not own runner transport, workflow execution, process
termination, or executor integrations. It may depend on `seqlane-core`, but
must not depend on Mastra or OpenCode.

The human projection will represent two distinct relationships:

```text
Containment tree:  workflow → nested workflow → task
Dependency graph:  task A → task B
```

Nested workflow nodes will have a `parentInvocationId` for visual containment.
Scheduling dependencies will remain separate `dependencyIds`. A normalized
view-model map will be used internally so event updates can address any node;
the renderer will derive visible rows from containment and expansion state.

Renderer state such as `isExpanded`, focus, terminal width, and ANSI capability
will remain local to the output package. It will not be added to canonical
Seqlane events.

The package will expose a small renderer contract, for example:

```ts
interface ExecutionRenderer {
  handle(event: RunnerEvent): void;
  finish(): Promise<void>;
}
```

The exact terminal library remains an implementation detail. Listr2 may be
evaluated for human rendering, but it must not become the execution model or a
dependency of `seqlane-core`.

## Options Considered

### Keep all projections in `apps/seqlane-cli`

Requires no new package and is initially simple. It would make the CLI own
event reduction, nested workflow state, ANSI rendering, CI formatting, and
machine output. This would make the command difficult to test and grow as more
output modes are added. Rejected.

### Put the human view model in `seqlane-core`

Would make the projection reusable by consumers, but would expose presentation
state and terminal concepts through the public core contract. It would also
make core depend on decisions that are specific to one output surface.
Rejected.

### Put renderers in `seqlane-runtime`

Would keep the CLI smaller, but couples the private execution runtime to TTY,
CI, and formatting concerns. Runtime consumers other than the CLI would inherit
unnecessary presentation dependencies. Rejected.

### Create a dedicated private output package

Adds one package and an explicit internal boundary. It isolates presentation
state, supports multiple renderers, enables event-sequence tests, and keeps core
and runtime executor-neutral. Chosen.

## Consequences

### Positive

- CLI command code remains responsible for wiring, flags, and exit status.
- Human, CI, and JSON output consume the same event stream.
- Nested workflows and parallel tasks can be tested without running a terminal.
- ANSI, cursor movement, collapse behavior, and terminal-width handling stay
  outside `seqlane-core`.
- Listr2 or another terminal library can be changed without changing runner or
  workflow contracts.
- Future local inspectors can reuse the event stream without depending on the
  CLI command implementation.

### Negative

- A new private package and package-level contract must be maintained.
- The human view model duplicates some execution state as a derived projection.
- The event contract must include enough metadata to create and correlate nested
  and not-yet-started invocations.
- Renderer behavior requires TTY, non-TTY, concurrency, nesting, and snapshot
  tests.
- Terminal rendering dependencies add CLI-side dependency and Node-version
  constraints.

## Follow-Up Constraints

- Add `libs/seqlane-output` with explicit package exports and declared
  dependencies only.
- Keep `seqlane-core` free of terminal, Listr2, Ora, Ink, and other renderer
  dependencies.
- Add invocation creation or plan-snapshot events containing stable ordering,
  task/workflow kind, parent invocation identity, and dependency identities.
- Keep canonical event data redacted before it reaches persistence, export, or
  output projections.
- Implement human mode with stable row ordering, nested collapse state,
  parallel active rows, and aggregate progress.
- Implement CI mode without ANSI sequences or carriage-return redraws, with
  periodic heartbeat output and a final summary.
- Keep renderer failures from changing the runner result or exit status.
- Add tests for nested workflows, parallel siblings, dependency waiting,
  retries, failure summaries, CI output, and JSON serialization.
- Update RFC-002 implementation material when the output package contract is
  introduced.

## Revisit Conditions

Revisit this decision if output becomes a separately distributed product, if a
shared non-terminal UI model is required by multiple consumers, or if the
renderer package grows into a full interactive application that warrants a
separate TUI package.

## Decision Test

The design is correct when the CLI can select and connect an output renderer
without containing execution-state reduction or terminal layout logic, while
the same runner event sequence correctly renders nested workflows, parallel
tasks, local human output, non-interactive CI output, and machine-readable JSON.
