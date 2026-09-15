---
id: task.build-interactive-run-tui
title: Build the Interactive Run TUI
status: planned
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - spec.run-terminal-rendering
  - task.rename-output-package-to-tui
supersedes: []
---

# Build the Interactive Run TUI

## Objective

Replace the custom human renderer with an inline Ink application. Add deep
nesting, navigation, details, scrolling, and root elapsed time.

## Upstream requirements

- [requirement-run-projection](../specs/2026-09-15-run-terminal-rendering.md#requirement-run-projection)
- [requirement-root-elapsed-time](../specs/2026-09-15-run-terminal-rendering.md#requirement-root-elapsed-time)
- [requirement-human-interaction](../specs/2026-09-15-run-terminal-rendering.md#requirement-human-interaction)
- [requirement-human-details](../specs/2026-09-15-run-terminal-rendering.md#requirement-human-details)
- [requirement-visual-language](../specs/2026-09-15-run-terminal-rendering.md#requirement-visual-language)
- [requirement-information-hierarchy](../specs/2026-09-15-run-terminal-rendering.md#requirement-information-hierarchy)
- [requirement-responsive-layout](../specs/2026-09-15-run-terminal-rendering.md#requirement-responsive-layout)
- [requirement-interaction-state](../specs/2026-09-15-run-terminal-rendering.md#requirement-interaction-state)
- [requirement-motion-and-update-quality](../specs/2026-09-15-run-terminal-rendering.md#requirement-motion-and-update-quality)
- [requirement-renderer-lifecycle](../specs/2026-09-15-run-terminal-rendering.md#requirement-renderer-lifecycle)

## Scope

- Add pinned Ink and React dependencies after the dependency audit.
- Add pure selectors for deep-tree rails, visible rows, focus, and viewport.
- Add root and per-node elapsed-time projection with an injected clock.
- Build inline header, tree, details, and key-guide components.
- Add focus movement, expansion, details, failure navigation, and scrolling.
- Implement the specified status vocabulary, information hierarchy, and key
  map without substitutions.
- Implement the four width and three height layout bands.
- Keep stable row positions and batch frames at the specified update rate.
- Preserve manual expansion and reveal failed ancestors.
- Emit cancellation intent without calling runtime APIs.
- Support resize, narrow terminals, no-color mode, and ASCII mode.
- Flush the final frame and restore all terminal state.
- Remove the superseded custom human renderer.

## Out of scope

- Alternate-screen mode, mouse input, or persistent run inspection.
- Changes to runtime cancellation semantics.
- CI renderer changes beyond shared projection integration.

## Implementation plan

1. Add pure projection actions and visible-row selectors.
2. Add elapsed-time and tree-rail behavior with deterministic tests.
3. Add Ink components without runtime or CLI imports.
4. Add input intent and viewport behavior.
5. Add terminal lifecycle cleanup and final-frame behavior.
6. Remove the old human renderer after behavior parity.

## Affected areas

- `libs/tui` projection, human renderer, components, and tests.
- `libs/tui/package.json` and `pnpm-lock.yaml`.
- Terminal snapshots and capability fixtures.
- Deterministic PTY captures for every normative human frame.

## Verification

Run the test-mapping check first. Test at least four containment levels and
interleaved parallel events. Test widths near 40, 80, and 120 columns.

Test navigation, collapse priority, failure reveal, scrolling, resize, ASCII,
and no-color output. Test terminal cleanup after success, error, cancellation,
startup error, and render error. Make sure that parallel children do not inflate
root elapsed time.

Capture active, compact, failed, succeeded, and cancelled terminal frames.
Compare active, compact, and failed captures with the normative specification.
Review snapshot changes as user-interface changes, not mechanical updates.

## Completion criteria

- Human mode supports the complete interaction contract.
- Root elapsed time stays visible and accurate.
- Deep nesting preserves clear branch ancestry.
- The final frame remains useful in terminal scrollback.
- Golden PTY captures match the normative hierarchy, symbols, spacing, and
  responsive rules.
- Progress updates do not cause unrelated rows to jump or flicker.
- The old custom human renderer is removed.
- Terminal resources are restored after every termination path.

## Outcome

Not delivered.

## Delivery state

Planned. This task starts after `task.rename-output-package-to-tui`.

## Traceability

- [spec.run-terminal-rendering: Run Terminal Rendering and Final Results](../specs/2026-09-15-run-terminal-rendering.md)
- [task.rename-output-package-to-tui: Rename the Output Package to TUI](./2026-09-15-rename-output-package-to-tui.md)
