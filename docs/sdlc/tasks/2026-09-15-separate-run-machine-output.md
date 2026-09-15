---
id: task.separate-run-machine-output
title: Separate Final Run Results from Event Output
status: planned
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - spec.run-terminal-rendering
supersedes: []
---

# Separate Final Run Results from Event Output

## Objective

Give `seqlane run --json` one final-result contract. Remove JSON events from
the renderer modes and preserve event recording as a separate function.

## Upstream requirements

- [requirement-three-run-consumers](../specs/2026-09-15-run-terminal-rendering.md#requirement-three-run-consumers)
- [requirement-final-json-result](../specs/2026-09-15-run-terminal-rendering.md#requirement-final-json-result)
- [requirement-event-recording-separation](../specs/2026-09-15-run-terminal-rendering.md#requirement-event-recording-separation)

## Scope

- Define the Zod-owned `RunCommandResult` success, failure, and cancellation
  variants in the CLI-owned contract boundary.
- Enable native Oclif JSON output for `run`.
- Preserve exact validated workflow results, including false-like values.
- Remove `json` from the run renderer modes and mode parser.
- Remove the JSON event renderer from the rendering package.
- Preserve `--record` as the canonical execution-event file.
- Give replay machine-event output an explicit NDJSON event option.
- Preserve current exit-status and cancellation behavior.

## Out of scope

- The package rename or interactive TUI.
- Changes to canonical execution-event schemas.
- Persistent run-result storage.

## Implementation plan

1. Add and test the `RunCommandResult` schema.
2. Return that result through the native Oclif JSON path.
3. Bypass renderer creation and progress output in JSON mode.
4. Remove the JSON renderer and migrate replay event output.
5. Update CLI help and entrypoint tests.

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

## Completion criteria

- `seqlane run --json` returns one validated final result.
- Run JSON mode writes no progress, heartbeats, ANSI data, or event records.
- `--output` accepts only `auto`, `human`, and `ci`.
- Replay event output has an explicit event-stream name.
- Existing run exit statuses remain stable.

## Outcome

Not delivered.

## Delivery state

Planned. No implementation or delivery evidence exists.

## Traceability

- [spec.run-terminal-rendering: Run Terminal Rendering and Final Results](../specs/2026-09-15-run-terminal-rendering.md)
