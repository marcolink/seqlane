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
- Inline failures, waiting reasons, and agent session links.
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
keyboard system. Session links and runtime lifecycle updates remain visible.
Mounted component tests and representative CLI validation pass.

## Outcome

Implemented on the feature branch. Ink hooks own animation and resize; the
custom scheduler, ANSI renderer, and inspector are removed. Mounted tests use
ink-testing-library. Focused rendering/projection tests, CLI integration tests,
typechecks, and TUI/CLI lint pass. A built real-terminal OpenCode run completed
both agent tasks and showed their session links with a 2/2 header.

No default-branch delivery claim is made. That requires a merged pull request.

## Traceability

- [spec.run-terminal-rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [task.rename-output-package-to-tui](./2026-09-15-rename-output-package-to-tui.md)
