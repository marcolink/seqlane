# TS-011-03 — Implement the Human TTY Renderer

**Status:** completed

## Use Case

**As a** local operator, **I want to** see live, collapsed task-list output,
**so that** active work is visible while completed work stays compact.

## Scope

- Render the human view model through an injected TTY-capable sink.
- Implement stable row rendering, indentation, status symbols, elapsed time,
  active phase, and concise activity.
- Render transient activity separately from persistent output.
- Render retry attempt and countdown, skip reason, and concise failure detail.
- Render updated task labels without moving the row.
- Support nested workflow collapse and active-branch expansion.
- Support parallel active rows without row reordering.
- Respect terminal width, terminal resize, ANSI support, and Unicode support.
- Coordinate redraw frames with diagnostic writes through the output sink.
- Add human-mode snapshots or equivalent deterministic render tests.

## Out of Scope

- CI fallback behavior.
- JSON output.
- Keyboard navigation and full-screen inspection.
- Task execution or event production.
- A public dependency on Listr2.
- Rollback or compensation execution.

## Implementation Notes

The renderer may use Listr2 or lower-level ANSI utilities, but those dependencies
must remain implementation details. The renderer must never parse runner stdout
or infer state from terminal text.

Use a recording TTY sink for tests. Keep terminal capabilities injected so tests
can verify redraw behavior, no-color/no-Unicode fallback, resize, and stream
coordination without relying on the host terminal.

## Acceptance Criteria

**Scenario:** Active work is expanded
- **Given:** A running invocation with a current phase and activity
- **When:** The human renderer receives its view model
- **Then:** It renders the active row and concise detail

**Scenario:** Completed nested work is collapsed
- **Given:** A nested workflow with completed descendants
- **When:** The human renderer receives the terminal state
- **Then:** It renders the workflow as a compact aggregate row

**Scenario:** Parallel work remains visible
- **Given:** Two active sibling invocations
- **When:** Their events arrive interleaved
- **Then:** Both rows remain visible and their activity stays associated with the correct task

**Scenario:** Terminal width is limited
- **Given:** Activity longer than the available width
- **When:** The renderer produces a frame
- **Then:** The output is truncated without corrupting ANSI or row layout

**Scenario:** Persistent output survives completion
- **Given:** An invocation with transient activity and persistent output
- **When:** The invocation completes
- **Then:** The persistent output remains available while transient detail is replaced

**Scenario:** Retry countdown is visible
- **Given:** An invocation waiting for its next retry
- **When:** The renderer produces a frame
- **Then:** It shows the attempt and remaining retry delay

**Scenario:** Dynamic labels remain stable
- **Given:** An invocation receives an updated human label
- **When:** The renderer produces a frame
- **Then:** It updates the label in place without changing row identity or order

**Scenario:** Terminal capabilities are respected
- **Given:** A sink without color, Unicode, or a full TTY
- **When:** The human renderer produces output
- **Then:** It uses safe fallback symbols and does not emit unsupported control sequences

**Scenario:** Diagnostic writes do not corrupt frames
- **Given:** A diagnostic write arrives during a live redraw
- **When:** The output sink flushes the frame
- **Then:** The diagnostic is buffered or routed without corrupting the task list

**Scenario:** Human rendering is TTY-only
- **Given:** A sink that does not support redraw
- **When:** Human mode is selected
- **Then:** The renderer refuses the unsupported capability or uses the explicit configured fallback

## Source

- [ADR-011 — Isolate Seqlane Execution Output](../../ADR-011-dedicated-seqlane-output-package.md)
- [TS-011 — Seqlane Execution Output Package](../../TS-011-seqlane-execution-output-package.md)
- [RFC-002 — Seqlane Execution Observability and Debugging](../../RFC-002-execution-observability-and-debugging.md)
