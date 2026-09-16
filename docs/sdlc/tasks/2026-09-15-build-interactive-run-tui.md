---
id: task.build-interactive-run-tui
title: Build Passive Run Output
status: completed
owners:
  - core
created: 2026-09-15
updated: 2026-09-16
upstream:
  - spec.run-terminal-rendering
  - task.rename-output-package-to-tui
supersedes: []
---

# Build Passive Run Output

## Objective

Deliver the agreed live tree with reusable Ink components. The user deferred
keyboard interaction on 2026-09-16. Preserve this task ID for traceability.

## Scope

- Passive header and nested tree with status colors and right-aligned facts.
- Automatic branch expansion, successful collapse, and failure reveal.
- Root wall-clock timing and accurate task completion counts.
- Inline failures, waiting reasons, and reported task context and usage.
- Omit session URLs from human output, as requested on 2026-09-16.
- Ink useAnimation and useWindowSize hooks; native maxFps and incremental redraw.
- Remove the custom frame scheduler, ANSI renderer, and input/inspector UI.
- Use ink-testing-library for mounted rendering, rerenders, and cleanup tests.
- Preserve pure event projection, bounds, CI output, and machine results.

## Verification

Run test mapping before focused tests. Cover nesting, completion rerenders,
retry/wait/failure output, narrow terminals, no-color and ASCII output.
Build packages before a real terminal run. Verify Ctrl+C follows ordinary CLI
signals and restores the terminal. Validate the SDLC indexes and documents.

## Completion criteria

The agreed passive design renders through Ink with no custom scheduling or
keyboard system. Runtime lifecycle updates remain visible. Session URLs must not
appear in the human tree or as side-channel terminal diagnostics.
Mounted component tests and representative CLI validation pass.

## Outcome

Implemented on the feature branch. Ink hooks own animation and resize; the
custom scheduler, ANSI renderer, and inspector are removed. Mounted tests use
ink-testing-library. Focused rendering/projection tests, CLI integration tests,
typechecks, and TUI/CLI lint pass. A built real-terminal OpenCode run completed
both agent tasks with a 2/2 header. Later runs verified expandable live task
details and successful collapse, without session URLs.

PR review follow-up covers early operational-host plan publication, planned
metadata reconciliation, batch projection, strict output retention, terminal
field encoding and redaction, and removal of obsolete interaction/resize code.

The final review fixes planned subject identity, dependency reindexing, dynamic
task totals, stable event order, control-safe redaction, large-plan scaling,
and isolated animation updates. Focused regressions cover each correction.

No default-branch delivery claim is made. That requires a merged pull request.

## Traceability

- [spec.run-terminal-rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [task.rename-output-package-to-tui](./2026-09-15-rename-output-package-to-tui.md)
