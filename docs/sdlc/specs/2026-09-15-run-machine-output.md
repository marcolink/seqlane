---
id: spec.run-machine-output
title: Run Machine Output and Command Errors
status: active
owners:
  - core
created: 2026-09-15
updated: 2026-09-16
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
  - adr.run-terminal-presentation-boundary
supersedes:
  - spec.seqlane-execution-output-package
---

# Run Machine Output and Command Errors

## Summary

`seqlane run --json` writes one final command result and no progress. Event
recording and replay NDJSON remain separate contracts.

Oclif owns the outer command error boundary. Seqlane normalizes errors before
Oclif shows human, CI, or JSON output. Command failures do not show a stack
trace unless the user enables debugging.

## Goals

- Define exact success, failure, and cancellation result variants.
- Keep final results separate from progress and execution-event records.
- Preserve workflow outputs such as `null`, `false`, and `0` exactly.
- Define stable replay NDJSON behavior.
- Show concise command errors and always restore run resources.

## Non-goals

- Terminal tree layout, CI progress lines, or TUI interaction.
- A persistent run-result store.
- A public event subscription API.
- Changes to the validated workflow output value.
- Debug stack-trace formatting.

## Terminology

- **Final result:** one `RunCommandResult` from the authoritative run outcome.
- **Event record:** one canonical execution event stored or replayed as NDJSON.
- **Command error:** an error before or after an authoritative run outcome.
- **Primary error:** the error that caused the command to stop.
- **Cleanup error:** an error that occurs while resources close.

## Requirements

### requirement-three-run-consumers

`seqlane run` supports these consumers:

- human terminal output
- append-only CI output
- one final JSON result

Human and CI modes consume validated execution events through
`@seqlane/tui`. Final JSON consumes the authoritative run outcome through the
CLI.

### requirement-mode-selection

The run command accepts `--output auto|human|ci`. Native Oclif `--json`
selects final-result mode. `--json` and an explicitly supplied `--output` are
mutually exclusive.

The CLI resolves the mode in this order:

1. `--json` selects final-result mode.
2. An explicit `--output` selects that terminal mode.
3. An interactive non-CI terminal selects human mode.
4. Every other environment selects CI mode.

Explicit human mode requires a usable terminal input and output. Missing
capabilities produce a typed usage error before execution starts.

### requirement-run-command-result-schema

The CLI owns strict Zod schemas for the `RunCommandResult` union. Every variant
has `schemaVersion: 1` and one status discriminator.

```ts
interface RunWorkflowIdentity {
  readonly id: string;
  readonly reference: string;
}

interface RunResultMetrics {
  readonly invocations: number;
  readonly retries: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

interface RunCommandError extends SerializedSeqlaneError {
  readonly code?: string;
  readonly suggestions?: readonly string[];
  readonly ref?: string;
}

interface RunSuccessResult {
  readonly schemaVersion: 1;
  readonly status: "succeeded";
  readonly workflow: RunWorkflowIdentity;
  readonly workId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly output: JsonValue;
  readonly metrics?: RunResultMetrics;
}

interface RunFailureResult {
  readonly schemaVersion: 1;
  readonly status: "failed";
  readonly phase: "command" | "execution" | "result-serialization";
  readonly error: RunCommandError;
  readonly workflow?: RunWorkflowIdentity;
  readonly workId?: string;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly metrics?: RunResultMetrics;
}

interface RunCancellationResult {
  readonly schemaVersion: 1;
  readonly status: "cancelled";
  readonly workflow: RunWorkflowIdentity;
  readonly workId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly cancellation: {
    readonly code:
      | "user_requested"
      | "signal"
      | "runtime_cancelled"
      | "policy";
    readonly message: string;
  };
  readonly metrics?: RunResultMetrics;
}

type RunCommandResult =
  | RunSuccessResult
  | RunFailureResult
  | RunCancellationResult;
```

All timestamps use ISO 8601 UTC. All durations use non-negative integer
milliseconds. Metrics use non-negative finite values.

Success requires `output` and omits `error`, `cancellation`, and `phase`.
Failure requires `error` and `phase`, and omits `output` and `cancellation`.
Cancellation requires `cancellation` and omits `output`, `error`, and `phase`.

A command-phase failure can occur before workflow or run identity exists. Only
the failure variant permits missing identity and timing fields.

The `RunCommandError` schema extends the canonical serialized Seqlane error
schema. It preserves Oclif error code, suggestions, and reference metadata when
those fields exist.

### requirement-result-serialization

Native Oclif JSON support prints the returned `RunCommandResult`. Every variant
is an object so false-like workflow outputs remain printable.

The CLI validates the complete result before it writes stdout. It serializes
the complete JSON text before the first write.

A non-JSON-safe workflow result becomes a failure result with phase
`result-serialization`. That failure envelope is written to stdout when it
passes its strict schema.

If the validated failure envelope cannot serialize, stdout remains empty. The
CLI writes one stderr diagnostic and exits with status `1`.

A result-serialization failure after a successful run changes the process exit
status to `1`. The failure envelope retains the successful run identity.

A serialization error after failure preserves exit status `1`. A serialization
error after cancellation preserves exit status `130`. These errors write one
concise stderr diagnostic.

Normal JSON success, failure, and cancellation write nothing to stderr. Human
and CI command errors write nothing to stdout. Debug output always uses stderr.

### requirement-exit-status

The exit-status precedence is:

1. Oclif help and usage behavior
2. cancellation status `130`
3. execution or command failure status `1`
4. successful execution status `0`

Renderer errors do not replace an authoritative run status. Result
serialization is not renderer behavior and follows the serialization rules.

### requirement-graceful-command-errors

The CLI uses Oclif `execute()` as the final error boundary. Commands do not add
an unstructured process-level catch solely to hide stack traces.

A shared Seqlane command boundary preserves Oclif help, usage, and exit errors.
It converts other unknown errors once into a typed, pretty-printable error.
The boundary delegates final handling to Oclif.

Implementation must verify this behavior against the installed Oclif `4.13.5`
source and the compiled production entrypoint.

Human and CI errors show:

- one concise message
- a stable error code when available
- one actionable suggestion when available
- one documentation reference when available

They do not show a stack trace by default. An explicit debug setting can show
the original stack and cause chain.

With `--json`, `toErrorJson()` returns the failure variant from
`RunCommandResult`. It does not emit Oclif's default unversioned error shape.

Run-specific resources use `try` and `finally`. Cleanup includes renderer
finalization, terminal restoration, signal listeners, event dispatch, event
recording, and an owned operational host.

The primary error remains authoritative when cleanup also fails. The CLI adds
cleanup information as a bounded diagnostic. It does not replace the primary
message, error code, or exit status.

### requirement-event-recording

`--record <path>` records validated canonical execution events independently
of human or CI output. The recorder writes the established bounded event-file
format. It is not a final command result.

`--json` and `--record` can run together. Stdout contains only the final result.
The event file contains only canonical event records. Recording diagnostics use
stderr.

### requirement-replay-event-output

Replay machine output uses this exact command:

```text
seqlane replay FILE --events ndjson
```

`ndjson` is the only initial `--events` value. `--events` and `--output` are
mutually exclusive. Replay retains `--output human|ci` for terminal projection.

With `--events ndjson`, stdout contains one validated canonical execution event
per line. Events remain in canonical sequence order. The serializer uses
deterministic object-field order and emits no human progress or ANSI data.

An invalid event stops replay before that event is written. The CLI writes a
typed stderr error with the record number and exits with status `1`. Earlier
complete lines remain valid canonical events.

## Detailed design or contracts

The command lifecycle is:

```text
Oclif execute
  -> command parse
  -> mode selection
  -> acquire run resources
  -> execute or observe run
  -> build authoritative result
  -> close resources in finally
  -> validate and serialize result
  -> Oclif output or error handling
```

The CLI does not catch all errors and convert them to strings inside `run()`.
Such conversion loses typed exit, JSON, help, and suggestion information.

### Success fixture

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
  "output": false,
  "metrics": {
    "invocations": 12,
    "retries": 1
  }
}
```

### Failure fixture

```json
{
  "schemaVersion": 1,
  "status": "failed",
  "phase": "execution",
  "error": {
    "category": "RuntimeError",
    "message": "Runner disconnected before the terminal event",
    "taskId": "integration-tests"
  },
  "workflow": {
    "id": "repository:review",
    "reference": "repository:review"
  },
  "workId": "019f2e9d-c2f1-7b44-a7a3-1c27e9b81130",
  "runId": "7f2c1ab4-c68e-4f69-a9a9-5447e5b420b3",
  "startedAt": "2026-09-15T09:14:22.184Z",
  "finishedAt": "2026-09-15T09:15:31.184Z",
  "durationMs": 69000
}
```

### Cancellation fixture

```json
{
  "schemaVersion": 1,
  "status": "cancelled",
  "workflow": {
    "id": "repository:review",
    "reference": "repository:review"
  },
  "workId": "019f2e9d-c2f1-7b44-a7a3-1c27e9b81130",
  "runId": "7f2c1ab4-c68e-4f69-a9a9-5447e5b420b3",
  "startedAt": "2026-09-15T09:14:22.184Z",
  "finishedAt": "2026-09-15T09:14:37.184Z",
  "durationMs": 15000,
  "cancellation": {
    "code": "signal",
    "message": "Run cancelled after SIGINT"
  }
}
```

## Failure and edge cases

- A failure before parsing uses phase `command` and can omit run identity.
- A runner disconnect after start uses phase `execution` and keeps identity.
- A non-JSON-safe result produces phase `result-serialization`.
- A second cleanup error does not hide the primary error.
- Broken stderr does not cause recursive error reporting.
- `EPIPE` follows Oclif's standard output behavior.
- Debug mode can show stacks. Default human, CI, and JSON output cannot.

## Migration

1. Add the result schemas and result builder.
2. Enable native Oclif JSON support for `run`.
3. Add the shared command error boundary and cleanup lifecycle.
4. Remove JSON from the renderer mode union.
5. Remove the JSON event renderer.
6. Add `replay --events ndjson`.
7. Remove the former `replay --output json` contract.

No compatibility alias remains after migration.

## Verification

Tests must prove:

- all three result variants accept only their required fields
- false-like success outputs remain exact
- pre-start and post-start failures use the correct optional fields
- JSON stdout contains one complete value and no progress
- serialization failure writes no partial stdout
- exit-status precedence matches every result and serialization combination
- default errors contain no stack frames
- debug errors retain the original cause and stack
- Oclif help, usage, suggestions, references, and exit errors remain intact
- every acquisition phase releases all previously acquired resources
- cleanup errors do not replace the primary error
- recording remains independent of terminal and JSON output
- replay NDJSON preserves order and reports the invalid record number
- `--events` and `--output` cannot be combined

Run compiled CLI tests for parse, setup, renderer, recorder, host, execution,
serialization, and cleanup errors. Inspect stdout, stderr, and exit status.

## Acceptance criteria

- `run --json` has one strict, versioned result union.
- Success, failure, and cancellation fixtures match actual output.
- Default command errors are concise and contain no stack trace.
- Every run resource closes after success, failure, or cancellation.
- Event recording remains separate from final results.
- Replay NDJSON uses the exact documented flag and output contract.
- No JSON renderer remains in `@seqlane/tui`.
- All required tests and workspace quality gates pass.

## Delivery state

Delivered to the default branch through pull requests
[#117](https://github.com/marcolink/seqlane/pull/117) and
[#121](https://github.com/marcolink/seqlane/pull/121).

## Traceability

- [prd.seqlane-on-mastra requirement-run-output-quality](../prd/2026-09-03-seqlane-on-mastra.md#requirement-run-output-quality)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.run-terminal-presentation-boundary: Separate Run Terminal Presentation from Machine Results](../adrs/2026-09-15-run-terminal-presentation-boundary.md)
- [spec.run-terminal-rendering: Run Terminal Rendering](./2026-09-15-run-terminal-rendering.md)
- Jointly supersedes [spec.seqlane-execution-output-package: Seqlane Execution Output Package](./2026-09-02-seqlane-execution-output-package.md).
- [Oclif error handling](https://oclif.io/docs/error_handling/)
