---
id: adr.passive-run-output
title: Use Passive Run Output
status: accepted
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
supersedes:
  - adr.run-terminal-presentation-boundary
---

# Use Passive Run Output

## Context

The agreed run design is a clean live execution tree. Keyboard navigation,
selection, and an inspector add complexity without serving the current need.
The user deferred the interactive decision on 2026-09-16.

## Decision

Keep the private terminal package and its separation from CLI machine results.
Human output becomes a passive nested tree with automatic branch expansion,
status colors, right-aligned facts, and a useful final frame. Remove keyboard
input, focus styling, help, and inspector panels.

Keep Ink and React for composition and terminal lifecycle. Use Ink hooks for
animation and dimensions, and Ink options for frame limiting and incremental
redraw. Do not build a second frame scheduling system around them.
Use ink-testing-library for mounted output tests.

The CLI owns signals, cancellation, machine results, and recording. CI remains
append-only. Human output does not enable raw stdin mode.

## Alternatives considered

An interactive inspector can be reconsidered when a concrete need exists.
A custom ANSI application would duplicate Ink layout and lifecycle behavior.

## Consequences

The current output needs no keyboard discovery or selected task. Users see
execution state directly and use terminal scrollback for long trees.
Ink and React remain private dependencies loaded only for human output.

## Delivery state

Implementation and focused validation are complete on the feature branch.
This record does not establish default-branch delivery.

## Traceability

- [Previous terminal boundary decision](./2026-09-15-run-terminal-presentation-boundary.md)
- [Run terminal rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.execution-observability-and-debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
