---
id: task.separate-run-machine-output
title: Separate Final Run Results from Event Output
status: completed
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - spec.run-machine-output
supersedes: []
---

# Separate Final Run Results from Event Output

## Objective

Give `seqlane run --json` one final-result contract. Remove JSON events from
the renderer modes and preserve event recording as a separate function.

## Upstream requirements

- [requirement-three-run-consumers](../specs/2026-09-15-run-machine-output.md#requirement-three-run-consumers)
- [requirement-run-command-result-schema](../specs/2026-09-15-run-machine-output.md#requirement-run-command-result-schema)
- [requirement-result-serialization](../specs/2026-09-15-run-machine-output.md#requirement-result-serialization)
- [requirement-graceful-command-errors](../specs/2026-09-15-run-machine-output.md#requirement-graceful-command-errors)
- [requirement-event-recording](../specs/2026-09-15-run-machine-output.md#requirement-event-recording)
- [requirement-replay-event-output](../specs/2026-09-15-run-machine-output.md#requirement-replay-event-output)

## Scope

- Define the Zod-owned `RunCommandResult` success, failure, and cancellation
  variants in the CLI-owned contract boundary.
- Enable native Oclif JSON output for `run`.
- Preserve exact validated workflow results, including false-like values.
- Remove `json` from the run renderer modes and mode parser.
- Remove the JSON event renderer from the rendering package.
- Preserve `--record` as the canonical execution-event file.
- Give replay machine-event output an explicit NDJSON event option.
- Add a shared Oclif command error boundary with typed human and JSON errors.
- Put all run-resource acquisition and cleanup under `try` and `finally`.
- Implement the specified exit-status and serialization precedence.

## Out of scope

- The package rename or interactive TUI.
- Changes to canonical execution-event schemas.
- Persistent run-result storage.

## Implementation plan

1. Add and test the `RunCommandResult` schema.
2. Return that result through the native Oclif JSON path.
3. Bypass renderer creation and progress output in JSON mode.
4. Remove the JSON renderer and migrate replay event output.
5. Add the shared Oclif error normalization and cleanup lifecycle.
6. Update CLI help and entrypoint tests.

## Affected areas

- `apps/cli` run, replay, mode selection, result contracts, and tests.
- `libs/output` renderer factory, exports, and JSON renderer.
- CLI documentation and examples.

## Verification

Run the test-mapping check first. Run focused CLI and output-package tests.
Run built CLI entrypoint tests for success, failure, and cancellation.

Make sure that stdout contains one JSON value and no progress. Test `null`,
`false`, and `0` results. Make sure that JSON mode never creates a renderer.
Make sure that `--record` still writes valid event records.

Make sure that normal JSON results leave stderr empty. Make sure that human and
CI command errors leave stdout empty. Test result validation and failure-envelope
serialization as different errors.

Inject errors during parse, setup, recording, host startup, execution,
serialization, and cleanup. Make sure that default output contains no stack.
Make sure that all acquired resources close and the primary error remains.

## Completion criteria

- `seqlane run --json` returns one validated final result.
- Run JSON mode writes no progress, heartbeats, or ANSI data. With `--record`,
  canonical event records go only to the requested event file.
- `--output` accepts only `auto`, `human`, and `ci`.
- Replay uses the exact `--events ndjson` contract.
- Human and JSON errors use the typed Oclif boundary.
- Default errors contain no stack trace.
- Exit-status precedence matches the active specification.

## Outcome

Implemented the CLI-owned `RunCommandResult` union and native Oclif JSON
result path. Run JSON mode bypasses terminal renderers and resize handling,
preserves false-like workflow outputs, and can record canonical events
independently. Renderer JSON mode was removed. Replay now exposes
`--events ndjson` with incremental validation and prefix preservation through a
dedicated replay-output helper. Shared Oclif error normalization reuses the
protocol's safe error formatter, typed JSON failure envelopes, resource
cleanup, and human terminal capability checks are implemented.

Focused verification passed:

- `pnpm test:mapping`
- `pnpm exec tsc --build apps/cli/tsconfig.json --pretty false`
- CLI contract, output, and recording Vitest suites (19 tests)
- protocol index and validation Vitest suites (16 tests)
- compiled CLI entrypoint suite (36 tests)
- `pnpm docs:index` and `pnpm docs:validate`

Invalid replay records preserve earlier complete lines and report both the
event record and physical line.

The scoped quality delta still reports the existing cross-layer
`writeDiagnostic` clone and short-horizon churn from this shared worktree. The
replay extraction reduced its verbosity delta to a minor finding; these
quality-lens rows do not indicate a replay behavior regression.

## Delivery state

Implementation complete in current working-tree change; default-branch delivery
pending commit/merge (status completed is task-document state, not delivery
proof).

## Traceability

- [spec.run-machine-output: Run Machine Output and Command Errors](../specs/2026-09-15-run-machine-output.md)
