---
id: spec.run-terminal-rendering
title: Run Terminal Rendering
status: active
owners:
  - core
created: 2026-09-15
updated: 2026-09-26
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
  - adr.passive-run-output
supersedes:
  - spec.seqlane-execution-output-package
---

# Run Terminal Rendering

## Summary

Human mode is a passive live terminal tree. CI mode is an append-only
progress log. Both modes consume the same validated execution events.

`@seqlane/tui` owns terminal projection and rendering. The CLI owns consumer
selection, cancellation wiring, final results, and exit status. Standalone runs
retain no event recordings under
[spec.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md).

## Goals

- Show arbitrarily deep workflow containment without losing execution context.
- Show nested work with automatic expansion and clear status.
- Show total wall-clock elapsed time on the root workflow.
- Keep CI output useful without terminal input or cursor control.
- Keep one pure run projection behind both terminal renderers.
- Keep terminal dependencies out of core, protocol, and runtime packages.

## Non-goals

- A persistent run inspector, alternate-screen dashboard, or replacement for
  Mastra Studio.
- Runtime scheduling, event persistence, machine output, or result storage.
- A public renderer plugin API.
- Token-level executor transcripts or unrestricted task output.
- Percentage completion for workflows that can discover work dynamically.

## Terminology

- **Human mode:** a passive live renderer for a capable terminal.
- **CI mode:** a non-interactive, append-only terminal renderer.
- **Run projection:** derived presentation data built from validated events.
- **Presentation state:** automatic expansion and visible rows.
- **Root elapsed time:** wall-clock time from `run.started` to now or the run
  terminal event.

## Requirements

### requirement-terminal-package-boundary

The private package path is `libs/tui`, and its package name is
`@seqlane/tui`. It can depend on `@seqlane/protocol` and stable primitives from
`@seqlane/core`.

It must not depend on runtime implementations, Mastra, OpenCode, runner
transport, or workflow-authoring implementation details. Core, protocol, and
runtime must not depend on Ink, React, or terminal formatting libraries.

The package root exports one renderer factory, renderer contracts, and required
consumer types. It does not export concrete components or renderer classes.

### requirement-renderer-contract

The package provides a boundary equivalent to:

```ts
type RunRenderMode = "human" | "ci";

type RunRendererConfig =
  | {
      readonly mode: "human";
      readonly terminal: TerminalStreams;
      readonly clock: Clock;
    }
  | {
      readonly mode: "ci";
      readonly output: OutputSink;
      readonly clock: Clock;
      readonly ticker: Ticker;
      readonly heartbeatIntervalMs: number;
    };

interface Clock {
  nowMs(): number;
}

interface Ticker {
  start(intervalMs: number, tick: () => void): StopTicker;
}

interface RunRenderer {
  handle(event: SeqlaneExecutionEvent): void;
  finish(): Promise<void>;
}

declare function createRunRenderer(
  config: RunRendererConfig,
): Promise<RunRenderer>;
```

The discriminated configuration must prevent invalid capability combinations.
The factory loads the human implementation dynamically. CI execution must not
load Ink or React.

`Clock.nowMs()` returns non-decreasing Unix epoch milliseconds. The clock is
the only source for elapsed time. Each ticker starts after
`run.started`. It stops after a terminal run event or `finish()`, whichever
occurs first. It cannot call the renderer after it stops. Human ticks update
elapsed time and spinner state. CI ticks evaluate heartbeat emission.

Ink owns frame throttling and animation through its standard hooks and render
options. `finish()` flushes Ink and unmounts React to release its resources.

### requirement-run-projection

The projection uses neutral names such as `RunViewModel`, `RunNode`, and
`RunAggregate`. It remains a pure transformation of validated events, an
injected clock, and explicit presentation actions.

The execution projection contains identity, containment, dependencies, stable
order, lifecycle state, output summaries, retry state, failures, and aggregate
counts. Presentation state remains separate from execution state.

Containment and dependencies remain different relationships:

```text
containment: root workflow -> child workflow -> task
dependency:  invocation A -> invocation B
```

The visible-row selector supports any containment depth. It computes depth,
ancestor continuation rails, branch position, and automatic expansion
position without modifying execution data.

### requirement-projection-bounds

The default projection limits are:

| Resource | Limit |
| --- | ---: |
| retained nodes | 10,000 |
| retained dependency edges | 50,000 |
| retained detail text for one node | 32 KiB |
| retained detail text for one run | 16 MiB |
| retained complete JSON values per run | 16 MiB |
| retained complete JSON records per run | 1,000 |
| persistent output chunks per node | 128 |
| pending render frames | 1 |
| retained raw-event backlog | 0 |

The reducer applies each event synchronously. It retains derived state instead
of raw events. Aggregate counters update from the changed node and its
ancestors. A normal frame does not scan all retained nodes.

Tree traversal is iterative. Actual containment depth does not consume the
JavaScript call stack. Visual indentation stops growing after 32 levels. A
depth marker preserves the omitted ancestor count.

After a topology limit, human mode keeps known nodes and root aggregate state.
It shows one synthetic limit row with cumulative omitted node and edge counts.
CI mode continues to show safe incoming lifecycle lines.

After a text or chunk limit, the projection keeps a UTF-8 boundary-safe prefix
and records truncation separately from payload bytes. Later content is dropped;
metrics can still update. One node marker and one run notice report truncation
without consuming the payload budget. Tests can inject smaller limits.

Text limits apply to output text and summaries. The separate JSON limits apply
to task inputs, results, activity records, and observations in the human
projection. It evicts the oldest complete records when either limit is reached.
An oversized record is omitted as a whole. One run notice reports cumulative
evictions; retained records are never redacted or truncated. CI output consumes
the canonical events before projection and retains their complete JSON values.
These outputs can display sensitive task data.

### requirement-root-elapsed-time

The root workflow always shows total elapsed time. An active run uses the
injected current time. A terminal run uses its terminal-event time.

Nested rows show their own durations when timestamps permit. Renderers must not
sum child durations because parallel intervals overlap.

### requirement-human-interaction

Human output is passive. It does not subscribe to keyboard input or enable raw
mode. The CLI owns ordinary SIGINT/SIGTERM cancellation.
Ink renders inline and leaves a final frame in terminal scrollback.

### requirement-human-details

Failures and waiting reasons appear under the affected row. Session URLs do not
appear in the human tree. There is no inspector, selected row, key guide,
identity banner, or routine tool-event tally.

Rows show fixed workspace mode, session label, and model when available. They
show complete retained task inputs, results, and the latest complete activity
record for each activity ID, including its input, output, and metadata when
present. These records remain visible after completion until the projection
evicts them under the JSON limits.
Active rows also show current progress and live activity status. Updates for one
activity ID replace its live line. Tool calls count
unique activity IDs, not streaming event counts. The retained count is capped
at 1,000 per invocation and displays a lower bound at that limit. Tree rails
span all wrapped detail lines. Successful rows keep full task values and fixed
context, then show four summary lines: fixed metadata; total token and cost
values; input/output/reasoning/cached token values; and per-tool and per-skill
counts. Duration remains right-aligned with the task title. Keys are muted and
values use stronger ANSI contrast.
Workspace paths and session IDs remain hidden until the event contract supplies
them.

### requirement-visual-language

Rows show ancestor rails, a branch connector, status, optional automatic
disclosure, label, and right-aligned facts. Label, rail, and fact hues identify
work types: blue workflows, cyan tasks, magenta validations, and yellow loops.
Running rows use bright, bold variants. Inactive rows are dimmed, except failures
and retries, which retain normal intensity. Task rows do not distinguish agent
and shell execution because the projection does not expose that distinction.
Status symbols use cyan for active work, green for success, yellow for retries
and waits, red for failure, and gray for queued or skipped work.
Symbols preserve meaning without color: spinner, ✓, ↻, ◌, ○, ✗, ■, and –.
ASCII terminals use equivalent punctuation. Expanded branches show ▼ and
completed collapsed branches show ▶. There is no selection highlight.

### requirement-information-hierarchy

One root header shows the workflow name, completion count, and wall-clock
elapsed time. One blank line separates it from the nested tree. The first task
must never supply the workflow label. Counts include all task invocations.
Rows align duration, aggregate counts, retry attempts, or waiting/queued state
on the right. Diagnostic detail is subordinate to the affected row.

### requirement-responsive-layout

Ink flex layout owns column alignment. Narrow output shortens labels and
secondary facts while preserving status and elapsed time. Terminal scrollback
provides access to long trees; no keyboard viewport hides work. Indentation and
retained projection state remain bounded. Ink owns resize subscriptions.

### requirement-interaction-state

Expansion is automatic: active and failed paths expand; completed successful
branches collapse. There are no user focus, selection, or navigation actions.

### requirement-motion-and-update-quality

Use Ink's useAnimation hook for active spinners and time refresh. Use
useWindowSize for terminal dimensions, maxFps: 12 for redraw limits, and
incrementalRendering for changed lines. Do not add a custom frame scheduler or
duplicate timer/resize system. React unmount cleans up hooks.
Animation stops in terminal run states. Flush through Ink before unmount.

CI heartbeat keeps its existing 30-second default. The passive human-output
change does not alter CI timing or machine contracts.

### requirement-ci-output

CI mode writes permanent lines for meaningful transitions and periodic
heartbeats. It never reads terminal input. It emits no cursor movement,
carriage-return redraw, or interactive control sequence.

Every status line contains `run=<full-run-id>`. Invocation status lines also
contain `invocation=<full-invocation-id>`. Labels and paths add context but do
not replace identity. The final summary contains the outcome, root elapsed
time, and aggregate counts.

ANSI styling is disabled unless the CLI explicitly reports support. GitHub
Actions annotations and step-summary output require explicit sinks.

For every `invocation.input`, `invocation.result`, and `invocation.activity`
event, CI mode writes the full canonical event as one JSON object per line. It
includes `runId`, `invocationId`, and `metadata.sequence`, plus all activity
lifecycle states. It has no status prefix or `run=` token. It bypasses
configured redaction and field-length limits. JSON encoding escapes terminal
control characters. These lines can contain sensitive task data.

Status lines use compact key-value text. Run transitions start with `run=<id>`;
invocation transitions start with `run=<id> invocation=<id>`. Heartbeats
start with `heartbeat run=<id>`. For example:

```text
run=run-1 started
run=run-1 invocation=task-1 started task=build label=Build
heartbeat run=run-1 elapsed=30000ms active=task-1
```

Optional fields follow the transition and are omitted when unavailable.
Complete JSON event lines use the protocol schema instead of this text format.

### requirement-terminal-field-encoding

CI status lines remove ANSI and control sequences, collapse whitespace, and
apply configured redactions. Individual dynamic status fields use
call-specific character limits. Human fields use `encodeTerminalField`, which
escapes unsafe controls. Complete task input, result, and activity JSON lines
use `encodeTerminalJson` instead: they escape unsafe controls but bypass
redaction and field-length limits.

GitHub Actions commands use a separate encoder. Command data escapes `%`, CR,
and LF as `%25`, `%0D`, and `%0A`. Command properties also escape `:` and `,`
as `%3A` and `%2C`. Dynamic values cannot create a new workflow command.

GitHub step-summary values escape HTML metacharacters and Markdown table pipes.
Newlines become `<br>`. Dynamic values cannot add raw HTML, headings, links, or
table structure.

### requirement-renderer-lifecycle

The CLI waits for renderer finalization before it returns. Human finalization
flushes the last frame and restores input mode, cursor visibility, listeners,
and signal behavior.

Cleanup runs after success, failure, cancellation, render errors, and startup
errors. Renderer errors remain diagnostic errors and do not change the run
outcome or its exit status.

## Detailed design or contracts

The package has this conceptual structure:

```text
libs/tui/src/
  index.ts
  renderer-contract.ts
  run-view-model.ts
  run-plan.ts
  run-topology.ts
  run-output.ts
  output-details.ts
  human-renderer.ts
  ci-renderer.ts
  human/
    app.tsx
    tree.tsx
    header.tsx
    tree-row.tsx
    format.ts
    task-details.tsx
```

The human tree uses these branch rules:

```text
workflow root                         12.4s
├─ child workflow                     8.1s
│  ├─ completed task                  1.2s
│  └─ active nested workflow          6.9s
│     ├─ active task                  4.0s
│     └─ waiting task
└─ completed task                     2.3s
```

An ancestor rail continues when a later sibling exists at that ancestor depth.
The last visible child uses an end branch. Collapsed descendants produce no
rows but remain in the execution projection.

Ink `7.1.1` and React `19.3.0` are the initial implementation dependencies.
They remain private implementation details and must load only in human mode.

## Normative rendering reference

The agreed passive tree uses this hierarchy. Colors follow the status rules.

### Active human frame at 100 or more columns

```text
⠸ ▼ repository:review                               5/12 · 01:42

├─ ✓ ▶ Prepare review                               2/2 · 12.4s
├─ ⠸ ▼ Review changes                               3/8 · 01:29
│  ├─ ✓ Inspect changed files                             31.8s
│  ├─ ✓ ▶ Core package                              2/2 · 22.3s
│  ├─ ⠸ ▼ Runtime package                           1/3 · 57.2s
│  │  ├─ ✓ Inspect boundaries                             8.7s
│  │  ├─ ↻ Run integration tests             attempt 2/3 · 4s
│  │  └─ ◌ Validate output                             waiting
│  ├─ ⠸ Analyze security                                 41.5s
│  └─ ◌ Write findings                                 waiting
└─ ○ Publish report                                     queued
```

### Compact human frame at 40 through 59 columns

Use the same hierarchy with shortened labels. Omit interaction controls and
panels at every width.

### Failed final frame

Retain the failed path, red failure symbols, and a bounded error below the
affected task. Successful branches stay collapsed. No selection is required.

### CI frame

```text
run=run-1 started
run=run-1 invocation=task-1 started task=build label=Build
{"type":"invocation.input","workId":"work-1","runId":"run-1","invocationId":"task-1","input":{"state":"present","value":{"source":"main"}},"metadata":{"schemaVersion":1,"eventId":"input-1","sequence":3,"occurredAt":"2026-09-26T00:00:00.000Z"}}
run=run-1 invocation=task-1 succeeded label=Build duration=2000ms
run=run-1 succeeded
task-duration run=run-1 invocation=task-1 label=Build state=succeeded duration=2.0s
summary run=run-1 outcome=succeeded total=1 succeeded=1 failed=0 skipped=0 failures=0 duration=2000ms cost=0
```

The example uses deterministic identifiers. Tests verify status fields and
complete JSON event lines separately.

## Failure and edge cases

- Out-of-order or duplicate events follow the protocol sequence policy.
- Unknown parent identities remain visible as bounded diagnostic state.
- A resize updates layout without changing execution state.
- A narrow terminal keeps status, label, and root elapsed time before details.
- A missing Unicode capability uses stable ASCII branches and status markers.
- Broken output sinks do not produce recursive renderer diagnostics.
- A terminal loss during a run triggers cleanup and a typed renderer error.
- Concurrent diagnostic output cannot corrupt the live frame.
- Dynamic children keep stable plan order and automatic expansion.
- Control characters in dynamic fields cannot create terminal or GitHub
  commands.
- Projection overflow remains visible and does not retain raw event history.

## Migration

1. Complete `spec.run-machine-output` result and event separation.
2. Rename `libs/output` to `libs/tui` without a compatibility package.
3. Rename human-specific projection types to neutral run types.
4. Add clock, scheduling, bounds, and field-encoding contracts.
5. Add deep-tree and elapsed-time selectors.
6. Replace the custom human renderer with the lazy Ink renderer.
7. Wire terminal modes, CLI signals, and cleanup.
8. Remove old paths, exports, tests, and documentation.

Each migration step must leave the repository buildable. A temporary internal
bridge must be removed before this specification is complete.

## Verification

Use ink-testing-library for mounted component tests, rerenders, and cleanup.
Pure projection tests remain ordinary unit tests.

Tests must prove:

- four or more containment levels render with correct branch rails
- stable sibling order survives interleaved parallel events
- Ink animation hooks stop on terminal state and unmount
- no ticker or frame callback runs after renderer finalization
- active expansion, successful collapse, and failure reveal work automatically
- root elapsed time uses wall-clock bounds and does not sum child durations
- resize, ASCII, no-color, and narrow widths work without keyboard input
- status symbols, disclosure symbols, and colors remain semantically
  consistent
- human golden frames match the normative active, compact, and failed frames
- CI status lines match their lifecycle-specific field order
- every CI status line has full run identity; JSON event lines have `runId`
- every invocation status line has full invocation identity; JSON event lines
  have `invocationId`
- complete JSON event lines parse without a status prefix or field limit
- ANSI, C0, C1, CR, LF, `%`, `::`, HTML, Markdown pipes, long text, and invalid
  UTF-8 boundary cases use the required encoding
- truncation always includes the original byte count
- node, edge, per-node text, total-text, and complete-value limits produce
  visible diagnostics
- deep trees use iterative traversal and bounded indentation
- the reducer retains no raw-event backlog
- aggregate updates do not scan the complete projection on each frame
- unrelated rows do not jump during progress and spinner updates
- renderer updates stay within the specified frame-rate limits
- terminal state is restored after every renderer termination path
- CI output contains no input reads, cursor movement, or carriage returns
- CI heartbeats and final root elapsed time use an injected clock
- renderer errors do not replace the run outcome or exit status
- no Mastra, OpenCode, Ink, or React types cross prohibited boundaries
- the compiled CLI passes representative human, CI, and cancellation smoke
  tests.

Run the test-mapping check before focused tests. Then run package tests,
typechecks, builds, lint checks, and the complete CLI entrypoint tests.

## Acceptance criteria

- `@seqlane/tui` is the only terminal-rendering package.
- `@seqlane/output` and its compatibility paths do not remain.
- Human mode provides the specified passive nested view.
- CI mode remains append-only and independent of terminal input.
- The root workflow shows accurate total elapsed time in human and CI modes.
- CI fields cannot inject terminal or GitHub control data.
- Projection memory and traversal obey the defined limits.
- All required tests and workspace quality gates pass.

## Delivery state

Implemented on the default branch through pull request #120. The delivery
includes bounded event projection, clock-based elapsed time, safe field
encoding, passive Ink rendering, CLI wiring, and renderer cleanup.

The review follow-up aligns plan subjects with runtime subjects. It also keeps
dependency indexes, task totals, event order, secret redaction, and large-plan
updates correct. Animation updates only the header and active rows.

The integration task tracks the final cross-mode CLI verification.

## Traceability

- [prd.seqlane-on-mastra requirement-run-output-quality](../prd/2026-09-03-seqlane-on-mastra.md#requirement-run-output-quality)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.passive-run-output: Use Passive Run Output](../adrs/2026-09-16-passive-run-output.md)
- [spec.run-machine-output: Run Machine Output and Command Errors](./2026-09-15-run-machine-output.md)
- Jointly supersedes [spec.seqlane-execution-output-package: Seqlane Execution Output Package](./2026-09-02-seqlane-execution-output-package.md).
