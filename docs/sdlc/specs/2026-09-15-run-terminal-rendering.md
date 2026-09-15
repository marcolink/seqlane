---
id: spec.run-terminal-rendering
title: Run Terminal Rendering and Final Results
status: active
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
  - adr.run-terminal-presentation-boundary
supersedes:
  - spec.seqlane-execution-output-package
---

# Run Terminal Rendering and Final Results

## Summary

`seqlane run` supports three consumer modes. Human mode is an interactive live
terminal tree. CI mode is an append-only progress log. JSON mode writes one
final machine result without progress.

`@seqlane/tui` owns terminal projection and rendering. The CLI owns mode
selection, final-result serialization, event recording, cancellation wiring,
and exit status.

## Goals

- Show arbitrarily deep workflow containment without losing execution context.
- Let a user select, expand, collapse, and inspect visible work.
- Show total wall-clock elapsed time on the root workflow.
- Keep CI output useful without terminal input or cursor control.
- Return one exact final result for scripts and pipes.
- Keep one pure run projection behind both terminal renderers.
- Keep terminal dependencies out of core, protocol, and runtime packages.

## Non-goals

- A persistent run inspector, alternate-screen dashboard, or replacement for
  Mastra Studio.
- Runtime scheduling, event persistence, replay execution, or result storage.
- A public renderer plugin API.
- Token-level executor transcripts or unrestricted task output.
- Percentage completion for workflows that can discover work dynamically.

## Terminology

- **Human mode:** an interactive renderer for a capable terminal.
- **CI mode:** a non-interactive, append-only terminal renderer.
- **Final-result mode:** native Oclif JSON output from the authoritative run
  outcome.
- **Run projection:** derived presentation data built from validated events.
- **Presentation state:** focus, expansion, viewport, and detail visibility.
- **Root elapsed time:** wall-clock time from `run.started` to now or the run
  terminal event.

## Requirements

### requirement-three-run-consumers

`seqlane run` must support human, CI, and final-result consumers. Human and CI
modes consume validated execution events. Final-result mode consumes the
authoritative run outcome.

The CLI accepts `--output auto|human|ci`. Native `--json` selects final-result
mode. `--json` and `--output` are mutually exclusive.

### requirement-mode-selection

The CLI resolves the mode in this order:

1. `--json` selects final-result mode.
2. An explicit `--output` value selects that terminal mode.
3. An interactive non-CI terminal selects human mode.
4. All other environments select CI mode.

Explicit human mode requires a usable TTY input and output. The CLI returns a
typed usage error when these capabilities are absent.

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
      readonly terminal: InteractiveTerminalPort;
      readonly onIntent: (intent: RunRendererIntent) => void;
    }
  | {
      readonly mode: "ci";
      readonly output: OutputSink;
      readonly heartbeatIntervalMs: number;
    };

interface RunRenderer {
  handle(event: SeqlaneExecutionEvent): void;
  finish(): Promise<void>;
}

declare function createRunRenderer(
  config: RunRendererConfig,
): Promise<RunRenderer>;
```

The discriminated configuration must prevent invalid capability combinations.
The factory loads the human implementation dynamically. CI and JSON execution
must not load Ink or React.

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
ancestor continuation rails, branch position, expansion, focus, and viewport
position without modifying execution data.

### requirement-root-elapsed-time

The root workflow always shows total elapsed time. An active run uses the
injected current time. A terminal run uses its terminal-event time.

Nested rows show their own durations when timestamps permit. Renderers must not
sum child durations because parallel intervals overlap.

### requirement-human-interaction

Human mode uses an inline Ink application. It leaves a useful final frame in
terminal scrollback and does not use the alternate screen.

The default view expands the active branch and collapses completed successful
branches. A failure reveals the failed node and its ancestors. A manual
expansion choice remains in effect until the user changes it.

The user can:

- move focus across visible rows
- expand or collapse a workflow row
- show or hide details for the focused row
- jump between failed rows
- show a compact key guide
- request cancellation with the established interrupt key

The TUI emits a cancellation intent. The CLI maps that intent to the existing
run-cancellation function.

The layout adapts to terminal width and height. It supports scrolling, text
truncation, resize, color disablement, and an ASCII fallback. Deep nesting
must preserve ancestor rails until width requires a compact indentation form.

### requirement-human-details

The root row shows the workflow label, status, elapsed time, and aggregate
counts. Child rows show status, label, duration, and concise current activity.

The details panel can show bounded persistent output, retry information,
waiting dependencies, failure information, execution metrics, used tools, and
used skills. It must not show values removed by protocol redaction or bounds.

### requirement-visual-language

Every tree row uses one status cell, one disclosure cell, one label column, and
one right-aligned facts column. Tree rails belong to the label column. A leaf
keeps the disclosure cell empty so labels stay aligned.

Human mode uses this status vocabulary:

| State | Unicode | ASCII | Color | Motion |
| --- | --- | --- | --- | --- |
| active | Braille spinner | `*` | cyan | spinner advances |
| succeeded | `✓` | `+` | green | none |
| retrying | `↻` | `~` | yellow | none |
| waiting | `◌` | `:` | yellow | none |
| queued | `○` | `.` | dim | none |
| failed | `✗` | `x` | red | none |
| cancelled | `■` | `!` | yellow | none |
| skipped | `–` | `-` | dim | none |

Expanded workflows use `▼`, and collapsed workflows use `▶`. ASCII mode uses
`v` and `>`. State must remain clear when color is disabled. Icons must use one
terminal cell in the supported terminal capability profile.

The focused row uses inverse video when ANSI is available. ASCII and no-color
modes use a leading `>` focus marker. Focus styling must not replace status.
Errors use red only in the details panel. Labels use the default terminal
foreground so large trees do not become visually noisy.

The title is bold. Secondary identity, paths, queued work, and help text are
dim. The TUI does not use borders around every row. It uses whitespace and one
separator before the details panel.

### requirement-information-hierarchy

The screen contains these zones in this order:

1. one run header line;
2. one subdued identity line;
3. one blank line;
4. the scrollable execution tree;
5. one details separator and the focused details, when visible;
6. one subdued controls line while the run is active.

The header left side shows the root workflow label and status. The header right
side shows aggregate completion and `total <elapsed>`. The second line shows
the Work ID, Run ID, and runtime when each value is available.

Tree rows show the most important facts on the right. The priority is retry
countdown, waiting state, failure state, aggregate counts, and duration. A row
must not show more than two facts at the same time.

The details panel has at most five visible lines:

1. focused label in bold;
2. dim containment breadcrumb;
3. lifecycle, attempt, wait, or cancellation information;
4. latest bounded error or persistent output;
5. duration, command, metrics, tools, or skills.

The panel wraps details. Tree rows never wrap. Additional details stay in the
projection and become visible through scrolling within the details view.

### requirement-responsive-layout

Human mode uses these layout bands:

| Terminal width | Required presentation |
| --- | --- |
| 100 columns or more | Full header, right facts, five detail lines, and full controls |
| 60 through 99 | Full tree, shortened identities, three detail lines, and compact controls |
| 40 through 59 | Status, tree, label, root elapsed, one detail line, and `? help · ^C cancel` |
| Less than 40 | Compact tree with ASCII-safe truncation and root elapsed |

Truncation preserves status, disclosure, the last label segment, and root
elapsed time. It removes secondary metrics before aggregate counts. It removes
aggregate counts before duration. It uses one ellipsis character, or three
dots in ASCII mode, for removed text.

At heights of 16 rows or more, all zones are available. At heights from 10
through 15 rows, details use at most one line. At smaller heights, the tree and
header remain visible. The details key temporarily replaces the tree viewport.

The viewport always keeps the focused row visible. Resize does not change
focus, expansion choices, or the selected failure.

### requirement-interaction-state

The key map is fixed:

| Key | Result |
| --- | --- |
| Up or `k` | Move focus to the previous visible row |
| Down or `j` | Move focus to the next visible row |
| Left or `h` | Collapse an expanded workflow, otherwise focus its parent |
| Right or `l` | Expand a collapsed workflow, otherwise focus its first child |
| Enter | Show or hide focused details |
| `f` | Focus the next failed row and reveal its ancestors |
| `?` | Show or hide the key guide |
| Ctrl+C | Request run cancellation through the CLI |

The first focus is the first active node in stable plan order. The root receives
focus when no invocation is active. Events do not steal focus after the user
moves it. A removed focused row transfers focus to its nearest visible
ancestor, then to the root.

Expansion priority is fixed. Failure reveal has highest priority. A manual
choice has second priority. Active-branch expansion has third priority.
Successful-branch collapse has lowest priority. Failure reveal does not erase
the stored manual choice.

Ctrl+C changes the header state to `cancelling` after the CLI accepts the
intent. Further input cannot change execution state. Existing CLI signal
policy defines the result of a later interrupt.

### requirement-motion-and-update-quality

The renderer batches event updates into one frame. It redraws immediately for
terminal lifecycle events and user input. Other updates render at most 12
frames each second. The elapsed-time display updates at most once each second.

The spinner is the only continuous animation. It stops after terminal state.
Rows keep stable vertical positions unless containment, expansion, or viewport
movement requires a change. Progress text must not cause unrelated rows to
jump.

The final frame removes the spinner and controls. Success collapses completed
branches and keeps the root summary. Failure keeps the failed path expanded
and focuses the first failed node. Cancellation keeps the cancelled path and
reason visible.

### requirement-ci-output

CI mode writes permanent lines for meaningful transitions and periodic
heartbeats. It never reads terminal input. It emits no cursor movement,
carriage-return redraw, or interactive control sequence.

Each line contains enough run and invocation identity to remain understandable
after parallel output interleaves. The final summary contains the outcome,
root elapsed time, and aggregate counts.

ANSI styling is disabled unless the CLI explicitly reports support. GitHub
Actions annotations and step-summary output require explicit sinks.

Each CI line follows this grammar:

```text
[elapsed] KIND identity message key=value...
```

`KIND` is one of `RUN`, `TASK`, `FLOW`, `PASS`, `RETRY`, `WAIT`, `FAIL`,
`SKIP`, `CANCEL`, `LIVE`, or `DONE`. Values with whitespace use JSON string
encoding. Fields use stable order. Unknown optional fields are omitted.

### requirement-final-json-result

The CLI owns a Zod schema for `RunCommandResult`. The schema represents success,
failure, and cancellation. It preserves the exact validated workflow result,
including `null`, `false`, and `0`.

With `--json`, stdout contains exactly one JSON value. Progress, heartbeats,
terminal diagnostics, ANSI sequences, and event records do not appear on
stdout. The CLI creates no renderer.

The process exit status remains consistent with the authoritative run outcome.
A renderer or serialization error must not replace that outcome silently.

### requirement-event-recording-separation

`--record <path>` records validated canonical events independently of terminal
mode. The event file is not the final command result.

The run command removes `json` from `--output`. Replay exposes machine events
through an explicit event-stream option such as `--events ndjson`. It does not
reuse the run final-result flag for event output.

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
  reducer.ts
  formatting/
  human/
    renderer.tsx
    app.tsx
    tree.tsx
    details.tsx
    navigation.ts
  ci/
    renderer.ts
    summary.ts
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

Ink `7.1.1` and React `19.2.4` are the initial implementation dependencies.
They remain private implementation details and must load only in human mode.

## Normative rendering reference

These frames define information hierarchy and density. Exact color cannot be
shown in Markdown. The status and focus rules define that color.

### Active human frame at 100 or more columns

```text
repository:review  running                              5/12 · total 01:42
work 019f2e9d… · run 7f2c1ab4… · runtime codex

⠸ ▼ repository:review                                  5/12 · 01:42
  ├─ ✓ ▶ Prepare review                                  2/2 · 12.4s
  ├─ ⠸ ▼ Review changes                                  3/8 · 01:29
  │  ├─ ✓   Inspect changed files                              31.8s
  │  ├─ ✓ ▶ Core package                                 2/2 · 22.3s
  │  ├─ ⠸ ▼ Runtime package                              1/3 · 57.2s
  │  │  ├─ ✓   Inspect boundaries                               8.7s
> │  │  ├─ ↻   Run integration tests                  attempt 2/3 · 4s
  │  │  └─ ◌   Validate output                                waiting
  │  ├─ ⠸   Analyze security                                  41.5s
  │  └─ ◌   Write findings                                    waiting
  └─ ○   Publish report                                        queued
────────────────────────────────────────────────────────────────────────────
Run integration tests
repository:review › Review changes › Runtime package
retrying · attempt 2/3 · next attempt in 4s
last error: runner disconnected before terminal event
previous attempt: 18.6s · command: pnpm test runtime
↑↓ select · ←→ collapse/expand · enter details · f failures · ? help · ^C cancel
```

### Compact human frame at 40 through 59 columns

```text
repository:review running        total 01:42

⠸ ▼ repository:review                 5/12
  ├─ ✓ ▶ Prepare review
  ├─ ⠸ ▼ Review changes                3/8
  │  ├─ ✓   Inspect changed files
  │  ├─ ⠸ ▼ Runtime package            1/3
> │  │  ├─ ↻   …integration tests      4s
  │  │  └─ ◌   Validate output     waiting
  └─ ○   Publish report             queued
────────────────────────────────────────
retrying · attempt 2/3 · next in 4s
? help · ^C cancel
```

### Failed final frame

```text
repository:review  failed                              8/12 · total 02:03
work 019f2e9d… · run 7f2c1ab4… · runtime codex

✗ ▼ repository:review                                   8/12 · 02:03
  ├─ ✓ ▶ Prepare review                                  2/2 · 12.4s
  ├─ ✗ ▼ Review changes                                  6/8 · 01:50
  │  ├─ ✗ ▼ Runtime package                              2/3 · 01:37
> │  │  ├─ ✗   Run integration tests                 failed · 01:09
  │  │  └─ –   Validate output                      dependency failed
  │  └─ –   Write findings                         dependency failed
  └─ –   Publish report                            dependency failed
────────────────────────────────────────────────────────────────────────────
Run integration tests
repository:review › Review changes › Runtime package
failed after 3 attempts
runner disconnected before terminal event
duration: 01:09 · command: pnpm test runtime
```

### CI frame

```text
[00:00] RUN  7f2c1a repository:review started runtime=codex
[00:13] TASK inspect-boundaries started path=review-changes/runtime-package/inspect-boundaries
[00:22] PASS inspect-boundaries duration=8.7s
[00:23] TASK integration-tests started attempt=1/3
[00:42] RETRY integration-tests attempt=1/3 delay=5s error="runner disconnected before terminal event"
[00:47] TASK integration-tests started attempt=2/3
[01:17] LIVE 7f2c1a elapsed=01:17 complete=5/12 active=2 waiting=2 retrying=1
[01:42] PASS runtime-package tasks=3/3 duration=01:29 tokens=18.4k cost=$0.21
[02:18] DONE 7f2c1a status=succeeded tasks=12/12 retries=1 total=02:18
```

### Final JSON frame

```json
{
  "schemaVersion": 1,
  "status": "succeeded",
  "workflow": {
    "id": "repository:review",
    "reference": "repository:review"
  },
  "workId": "019f2e9d-c2f1-7b44-a7a3-1c27e9b81130",
  "runId": "7f2c1ab4-c68e-4f69-a9a9-5447e5b420b3",
  "startedAt": "2026-09-15T09:14:22.184Z",
  "finishedAt": "2026-09-15T09:16:40.492Z",
  "durationMs": 138308,
  "output": {
    "verdict": "approve",
    "summary": "Runtime boundaries remain intact.",
    "findings": [],
    "changedFiles": 7
  },
  "metrics": {
    "invocations": 12,
    "retries": 1,
    "inputTokens": 16420,
    "outputTokens": 1984,
    "costUsd": 0.21
  }
}
```

All result variants share `schemaVersion`, `status`, `workflow`, identity,
timestamps, duration, and available metrics. A success has `output`. A failure
has a typed `error`. A cancellation has a typed `cancellation` reason. These
three fields are mutually exclusive.

Golden fixtures can replace identifiers and timing values with deterministic
tokens. They must preserve all spacing, glyphs, field order, and layout rules
shown here.

## Failure and edge cases

- Out-of-order or duplicate events follow the protocol sequence policy.
- Unknown parent identities remain visible as bounded diagnostic state.
- A removed focused row moves focus to its nearest visible ancestor.
- A resize preserves focus and scrolls only enough to keep focus visible.
- A narrow terminal keeps status, label, and root elapsed time before details.
- A missing Unicode capability uses stable ASCII branches and status markers.
- Broken output sinks do not produce recursive renderer diagnostics.
- A terminal loss during a run triggers cleanup and a typed renderer error.
- Concurrent diagnostic output cannot corrupt the interactive frame.
- Dynamic children keep stable plan order and do not reset manual expansion.

## Migration

1. Add final-result JSON to the CLI while `@seqlane/output` still exists.
2. Remove the JSON event renderer from the renderer contract.
3. Rename `libs/output` to `libs/tui` without a compatibility package.
4. Rename human-specific projection types to neutral run types.
5. Add navigation, viewport, deep-tree, and elapsed-time selectors.
6. Replace the custom human renderer with the lazy Ink renderer.
7. Wire run modes, cancellation intent, cleanup, and replay event output.
8. Remove old paths, exports, flags, tests, and documentation.

Each migration step must leave the repository buildable. A temporary internal
bridge must be removed before this specification is complete.

## Verification

Tests must prove:

- four or more containment levels render with correct branch rails
- stable sibling order survives interleaved parallel events
- manual expansion, active expansion, and failure reveal have defined priority
- root elapsed time uses wall-clock bounds and does not sum child durations
- focus, scrolling, details, resize, ASCII, no-color, and narrow widths work
- status symbols, disclosure symbols, colors, and focus remain semantically
  consistent
- human golden frames match the normative active, compact, and failed frames
- CI golden lines match the normative kind, spacing, and field order
- final JSON matches the normative envelope and variant rules
- unrelated rows do not jump during progress and spinner updates
- renderer updates stay within the specified frame-rate limits
- terminal state is restored after every renderer termination path
- CI output contains no input reads, cursor movement, or carriage returns
- CI heartbeats and final root elapsed time use an injected clock
- `--json` writes one value and no progress for all terminal outcomes
- `null`, `false`, and `0` workflow results remain unchanged
- JSON mode never constructs a renderer or loads Ink
- event recording remains independent of all output modes
- renderer errors do not replace the run outcome or exit status
- no Mastra, OpenCode, Ink, or React types cross prohibited boundaries
- the compiled CLI passes representative human, CI, JSON, cancellation, and
  recording smoke tests.

Run the test-mapping check before focused tests. Then run package tests,
typechecks, builds, lint checks, and the complete CLI entrypoint tests.

## Acceptance criteria

- `@seqlane/tui` is the only terminal-rendering package.
- `@seqlane/output` and its compatibility paths do not remain.
- Human mode provides the specified interactive nested view.
- CI mode remains append-only and independent of terminal input.
- Final-result mode writes one validated result without progress.
- The root workflow shows accurate total elapsed time in human and CI modes.
- Event recording remains an explicit, separate function.
- All required tests and workspace quality gates pass.

## Delivery state

Not delivered. This active specification defines the target contract. The
current implementation remains under `@seqlane/output`.

## Traceability

- [prd.seqlane-on-mastra requirement-run-output-quality](../prd/2026-09-03-seqlane-on-mastra.md#requirement-run-output-quality)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.run-terminal-presentation-boundary: Separate Run Terminal Presentation from Machine Results](../adrs/2026-09-15-run-terminal-presentation-boundary.md)
- Supersedes [spec.seqlane-execution-output-package: Seqlane Execution Output Package](./2026-09-02-seqlane-execution-output-package.md).
