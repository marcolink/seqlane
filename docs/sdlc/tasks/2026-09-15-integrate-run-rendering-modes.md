---
id: task.integrate-run-rendering-modes
title: Integrate and Verify Run Rendering Modes
status: planned
owners:
  - core
created: 2026-09-15
updated: 2026-09-16
upstream:
  - spec.run-terminal-rendering
  - spec.run-machine-output
  - task.separate-run-machine-output
  - task.build-interactive-run-tui
supersedes: []
---

# Integrate and Verify Run Rendering Modes

## Objective

Wire the human, CI, and final-result paths into `seqlane run`. Prove their
behavior through the compiled CLI and remove migration artifacts.

## Upstream requirements

- [requirement-mode-selection](../specs/2026-09-15-run-machine-output.md#requirement-mode-selection)
- [requirement-renderer-contract](../specs/2026-09-15-run-terminal-rendering.md#requirement-renderer-contract)
- [requirement-ci-output](../specs/2026-09-15-run-terminal-rendering.md#requirement-ci-output)
- [requirement-terminal-field-encoding](../specs/2026-09-15-run-terminal-rendering.md#requirement-terminal-field-encoding)
- [requirement-run-command-result-schema](../specs/2026-09-15-run-machine-output.md#requirement-run-command-result-schema)
- [requirement-graceful-command-errors](../specs/2026-09-15-run-machine-output.md#requirement-graceful-command-errors)
- [requirement-visual-language](../specs/2026-09-15-run-terminal-rendering.md#requirement-visual-language)
- [requirement-responsive-layout](../specs/2026-09-15-run-terminal-rendering.md#requirement-responsive-layout)
- [requirement-renderer-lifecycle](../specs/2026-09-15-run-terminal-rendering.md#requirement-renderer-lifecycle)

## Scope

- Implement the final mode-resolution order in the run command.
- Supply terminal streams, initial capabilities, and cancellation intent to
  human mode. Ink owns resize subscriptions and layout updates.
- Keep CI mode append-only, non-interactive, and independent of Ink.
- Include full run identity on every CI line and full invocation identity on
  each invocation line.
- Apply the canonical terminal, GitHub command, and summary encoders.
- Finalize renderers before the command returns.
- Preserve authoritative outcome and exit-status behavior after renderer errors.
- Update help, examples, package documentation, and CLI behavior tests.
- Add deterministic PTY captures and exact CI and JSON golden fixtures.
- Remove temporary adapters, stale flags, and obsolete snapshots.
- Run all workspace quality and documentation gates.

## Out of scope

- New execution events or runtime behavior.
- Persistent run inspection or external observability export.
- Changes to `list`, `plan`, `status`, or `cancel` JSON contracts unless shared
  Oclif behavior requires a focused correction.

## Implementation plan

1. Wire mode selection and terminal capabilities.
2. Wire cancellation intent and renderer lifecycle.
3. Prove that CI and JSON paths do not load Ink.
4. Add compiled CLI smoke coverage for every run outcome and mode.
5. Remove migration code and synchronize all nearby documentation.

## Affected areas

- `apps/cli` run command, output adapter, help, and entrypoint tests.
- `libs/tui` CI integration and lifecycle contract.
- The shared CLI command error boundary and run cleanup lifecycle.
- CLI and TUI README files.
- Workspace dependency and boundary checks.

## Verification

Run `pnpm test:mapping` before focused tests. Run TUI and CLI tests, typechecks,
builds, lint checks, and documentation validation. Then run the full workspace
suite required by the repository.

Use the compiled CLI for interactive TTY, redirected output, CI, JSON success,
JSON failure, cancellation, and event-recording smoke tests. Inspect raw output
for ANSI or progress leakage. Make sure that CI and JSON do not load Ink.

Use adversarial CI values that contain ANSI, controls, newlines, GitHub command
syntax, HTML, Markdown pipes, long text, and multi-byte Unicode. Make sure that
the output remains one safe attributable line.

Review human PTY captures at every specified width and height band. Compare CI
field order and final JSON envelopes with the normative frames. Do not approve
unexplained golden-fixture changes.

## Completion criteria

- Automatic and explicit mode selection match the active specification.
- Human mode stays passive and restores the terminal.
- CI mode needs no TTY and writes only permanent lines.
- Every CI line has the required stable identity and safe field encoding.
- JSON mode writes one final result and no progress.
- Recording works independently in all compatible modes.
- Human, CI, and JSON golden evidence matches the normative reference.
- No temporary adapter, old package name, or stale output flag remains.
- All repository and documentation gates pass.

## Outcome

Not delivered.

## Delivery state

Planned. This task completes the run-rendering delivery sequence.

## Traceability

- [spec.run-terminal-rendering: Run Terminal Rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [spec.run-machine-output: Run Machine Output and Command Errors](../specs/2026-09-15-run-machine-output.md)
- [task.separate-run-machine-output: Separate Final Run Results from Event Output](./2026-09-15-separate-run-machine-output.md)
- [task.build-interactive-run-tui: Build the Interactive Run TUI](./2026-09-15-build-interactive-run-tui.md)
