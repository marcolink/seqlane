---
id: adr.run-terminal-presentation-boundary
title: Separate Run Terminal Presentation from Machine Results
status: accepted
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
  - adr.separate-seqlane-protocol-package
supersedes:
  - adr.dedicated-seqlane-output-package
---

# Separate Run Terminal Presentation from Machine Results

## Context

`@seqlane/output` currently combines three different contracts:

- a live terminal projection for people
- permanent progress logs for CI
- a JSON stream of execution events

The live renderer now needs keyboard input, selection, scrolling, nested
expansion, and detail panels. The existing ADR identifies this growth as a
reason to create a TUI package.

The JSON event stream also has different semantics from a final command result.
A caller that pipes `seqlane run --json` needs one result and no progress.
Event recording is a separate diagnostic function.

## Decision

Rename the private `@seqlane/output` package to `@seqlane/tui`. The package
owns terminal presentation for `seqlane run`:

- an interactive human renderer
- an append-only CI renderer
- the shared, pure run projection used by both renderers
- terminal-safe formatting and bounded presentation state

The package name uses TUI to mean terminal user interface. The CI renderer is
a non-interactive terminal interface within the same presentation boundary.

The CLI owns consumer selection and machine results. Native Oclif `--json`
returns one final `RunCommandResult` and creates no terminal renderer. The
existing `--record` function remains the canonical event-recording path.

The interactive renderer uses Ink and React. The CLI loads this renderer only
after it selects human mode. CI and JSON paths do not load Ink or React.

The boundary is:

```text
validated execution events ──> @seqlane/tui ──> interactive terminal
                                      └───────> append-only CI log

authoritative run outcome ────> apps/cli ─────> final --json result
validated execution events ───> recorder ─────> --record event file
```

`@seqlane/tui` does not own runtime execution, transport, signal handling,
process exit status, result schemas, or event persistence. Its root export
contains one renderer factory and its consumer contracts. Concrete components
and renderer implementations remain private.

The CLI maps TUI cancellation intent to the existing run-cancellation path.
The TUI does not call runtime cancellation APIs directly.

## Alternatives considered

### Keep `@seqlane/output`

Rejected. The name permits unrelated output contracts and hides the terminal
boundary. It also keeps final results and event streams coupled to presentation.

### Create separate human, CI, and projection packages

Rejected. The renderers share one terminal projection and one real application
consumer. Three packages add boundaries without independent ownership.

### Put the interactive renderer in the CLI

Rejected. The command then owns layout, navigation, state reduction, and
terminal cleanup. This repeats the responsibility problem from the superseded
ADR.

### Keep JSON events as a renderer mode

Rejected. Event records represent execution history. A final JSON result
represents the command outcome. One flag cannot safely mean both contracts.

### Use a custom ANSI renderer

Rejected for the interactive mode. Keyboard input, viewport state, cleanup,
and component composition require an application model. Ink supplies these
functions while keeping execution semantics outside the UI.

## Consequences

- Human and CI output continue to consume the same validated event stream.
- The shared projection becomes presentation-neutral instead of human-named.
- JSON consumers receive one final result without progress noise.
- Event consumers use `--record` or an explicit replay event format.
- CI and JSON startup do not pay the Ink and React module cost.
- The CLI must coordinate renderer shutdown before it returns the result.
- Interactive cancellation must restore terminal state before process exit.
- The package rename is breaking. Seqlane adds no compatibility package or
  duplicate export path.
- Replay machine-event output needs an explicit event-stream contract during
  migration.

## Delivery state

Not delivered. The current source still uses `@seqlane/output` and combines
human, CI, and JSON renderers.

## Traceability

- [prd.seqlane-on-mastra: Seqlane on Mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.separate-seqlane-protocol-package: Separate Seqlane Protocol Contracts from Core Authoring](./2026-09-13-separate-seqlane-protocol-package.md)
- Supersedes [adr.dedicated-seqlane-output-package: Isolate Seqlane Execution Output in a Dedicated Package](./2026-09-02-dedicated-seqlane-output-package.md).
