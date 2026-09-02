# TS-002 — Dedicated Runner Process and CLI IPC

**Status:** Implemented
**Implements:** ADR-002
**Depends on:** TS-001
**Scope:** MVP

## 1. Objective

Run every `seqlane run` invocation in a fresh Node child process while keeping the oclif process responsible only for command handling, supervision, presentation, signal forwarding, and exit status.

The runner, not the CLI, loads the workflow, builds and validates the Seqlane Plan, compiles it through the private Mastra runtime, owns execution state, and connects to the configured OpenCode server.

```text
seqlane run <workflow>
        │
        ▼
  oclif supervisor
        │ Seqlane-owned IPC
        ▼
  fresh Seqlane runner
        │
        ├── workflow import
        ├── Plan construction and validation
        ├── Mastra execution
        ├── executor/session state
        └── structured lifecycle events
```

## 2. Normative Invariants

- Every `seqlane run` creates exactly one fresh runner process.
- The runner is foreground, child-owned by the invoking CLI, and not detached.
- The runner exits after success, failure, or cancellation.
- Runner processes are never reused between independent runs.
- The CLI never imports the selected workflow for execution and never constructs or receives the executable Plan.
- The runner imports the workflow and builds the Plan itself.
- Mastra, executor, OpenCode, and run state remain inside the runner process.
- Only Seqlane-owned, JSON-serializable protocol messages cross the process boundary.
- The runner executes autonomously after startup; the CLI sends no runtime decision or input messages.
- Cancellation is forwarded structurally; hard termination is only a bounded-grace fallback.
- An externally owned OpenCode server is never terminated by Seqlane.

## 3. Package Responsibilities

### `@seqlane/core`

Owns the public, Mastra-independent protocol and serializable data contracts:

- `WorkflowReference`;
- `RunRequest` and `CancelRun`;
- runner events;
- serialized Seqlane errors;
- JSON-serializability guards or equivalent validation.

Core must not import Node process APIs, oclif, Mastra, or OpenCode types.

### `@seqlane/runtime`

Owns the runner entry point and child-process execution:

- protocol decoding and command handling;
- workflow module loading;
- Plan construction and validation;
- Mastra compilation and execution through TS-001;
- executor and OpenCode runtime state;
- cancellation and cleanup;
- conversion of in-process events/errors into process-safe events.

### `seqlane`

Owns the oclif command and parent-process supervision:

- command parsing and workflow discovery;
- conversion of the selected workflow into a `WorkflowReference`;
- fresh runner launch;
- initial request delivery;
- event rendering;
- signal handling and cancellation forwarding;
- terminal outcome and exit-code mapping.

The CLI must not depend on Mastra or own workflow execution state.

## 4. Process Boundary Contract

The semantic protocol is independent of Node IPC. Node child-process IPC is the V1 transport.

The process-boundary types are distinct from in-process `SeqlaneEvent` types where necessary: in-process `SeqlaneError` instances and causes must be serialized before transport.

### 4.1 Workflow reference

The CLI sends a reference that the runner can import. It does not send a Plan or an executable workflow object.

```ts
interface WorkflowReference {
  readonly id: string
  readonly moduleSpecifier: string
  readonly exportName: string
}
```

`moduleSpecifier` and `exportName` must be sufficient for the runner to load the same workflow selected by the CLI. The runner validates the loaded export before execution.

### 4.2 Commands

```ts
type JsonPrimitive = string | number | boolean | null
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

interface OpenCodeConnection {
  readonly url: string
}

interface RunRequest {
  readonly type: "run.start"
  readonly workflow: WorkflowReference
  readonly input: JsonValue
  readonly opencode: OpenCodeConnection
}

interface CancelRun {
  readonly type: "run.cancel"
}

type RunnerCommand = RunRequest | CancelRun
```

`RunRequest` is sent once after the IPC channel is connected. `CancelRun` is the only command permitted after startup.

### 4.3 Events

```ts
interface SerializedSeqlaneError {
  readonly category:
    | "InputValidationError"
    | "ExecutorError"
    | "OutputValidationError"
    | "RuntimeError"
  readonly message: string
  readonly taskId?: string
}

type RunnerEvent =
  | { readonly type: "run.started"; readonly workId: string; readonly runId: string }
  | {
      readonly type: "invocation.started"
      readonly workId: string
      readonly runId: string
      readonly invocationId: string
      readonly taskId: string
    }
  | {
      readonly type: "invocation.succeeded"
      readonly workId: string
      readonly runId: string
      readonly invocationId: string
    }
  | {
      readonly type: "invocation.failed"
      readonly workId: string
      readonly runId: string
      readonly invocationId: string
      readonly error: SerializedSeqlaneError
    }
  | { readonly type: "run.succeeded"; readonly workId: string; readonly runId: string; readonly output: JsonValue }
  | {
      readonly type: "run.failed"
      readonly workId: string
      readonly runId: string
      readonly error: SerializedSeqlaneError
    }
  | { readonly type: "run.cancelled"; readonly workId: string; readonly runId: string }
```

The runner sends exactly one terminal event: `run.succeeded`, `run.failed`, or `run.cancelled`. No Mastra, OpenCode, `Error`, stream, workflow, executor, or Plan object crosses the boundary.

`JsonValue` is the protocol's recursive JSON value type. Inputs, successful outputs, and all message fields must be JSON-serializable. Error causes and stack traces are not transported.

## 5. Runner Lifecycle

```text
CLI parses/discovers workflow
        ↓
CLI launches fresh child with IPC
        ↓
CLI sends RunRequest
        ↓
runner validates request and allocates Work and Run IDs
        ↓
runner emits run.started
        ↓
runner imports workflow and builds/validates Plan
        ↓
runner compiles and executes through TS-001
        ↓
runner emits invocation events
        ↓
runner emits one terminal event
        ↓
runner releases run-scoped resources and exits
        ↓
CLI maps terminal event to process exit status
```

The CLI may discover workflow files and resolve a module reference, but must not import the workflow to build or execute it. All execution-time module loading occurs in the runner.

The runner emits `run.started` before workflow loading so load, Plan, and validation failures have a run identity and a structured `run.failed` outcome.

If the runner cannot decode the initial request or allocate a run, it reports a startup/protocol failure through its diagnostics and exits non-zero; no fabricated run event is required when no valid run exists.

## 6. CLI Supervision

The parent process:

1. creates a child with an IPC channel and no detached/background mode;
2. sends one `RunRequest`;
3. accepts only valid `RunnerEvent` messages;
4. renders events as human-readable CLI output;
5. forwards operating-system cancellation as `CancelRun`;
6. waits for the terminal event and child exit;
7. reports a protocol/process failure if the child exits without a terminal event.

The renderer is a projection of structured events. It must not infer execution state by parsing runner stdout or executor transcripts.

The runner must not use stdout as the canonical event channel. Diagnostic output is not a substitute for protocol events.

## 7. Terminal Outcomes and Exit Status

The semantic terminal event is authoritative when present.

| Runner outcome | CLI exit status |
| --- | ---: |
| `run.succeeded` | `0` |
| `run.failed` | `1` |
| `run.cancelled` | `130` |
| startup/protocol failure or unexpected runner exit | `1` |

The runner exits after sending its terminal event. The CLI must not wait indefinitely for a child that has already reported a terminal outcome.

An unexpected child exit without a terminal event is reported as a runner failure and does not get treated as success merely because the child exit code was zero.

## 8. Cancellation

```text
SIGINT / SIGTERM
       ↓
      CLI
       ↓
   CancelRun
       ↓
runner AbortController
       ↓
 Mastra cancellation
       ↓
 executor/OpenCode abort
       ↓
 cleanup
       ↓
 run.cancelled
```

- The CLI installs signal handlers only for the duration of the active run.
- The first signal sends one `CancelRun` and begins the graceful-cancellation wait.
- Repeated signals do not create additional semantic commands.
- The runner forwards its abort signal through the TS-001 runtime to the active executor.
- The runner emits `run.cancelled` after cancellation cleanup.
- If graceful cancellation does not complete within a bounded implementation-defined grace period, the CLI terminates the child and exits with `130`.
- The cancellation path never stops an externally owned OpenCode server.

Cancellation before the runner starts execution is handled as a latched abort; the workflow must not perform task work after cancellation is accepted.

## 9. Failure Handling

The runner normalizes failures from workflow loading, Plan validation, Mastra execution, executor execution, output validation, and cancellation into Seqlane-owned categories before emitting events.

The runner must:

- emit an invocation failure before a run failure when a task invocation fails;
- stop downstream execution after failure, as defined by TS-001;
- omit raw error causes, secrets, SDK objects, and non-serializable values from protocol messages;
- release run-scoped state before exiting.

Malformed commands, unknown message types, duplicate start commands, and invalid event payloads are protocol failures. They must not result in undefined execution or a second run in the same child.

## 10. Autonomous Execution

After `RunRequest`, the runner proceeds without user interaction. There is no protocol message for:

- user input;
- confirmations;
- permission approvals;
- branch decisions;
- task-specific responses.

If the selected workflow or OpenCode environment requires unresolved interaction, the runner fails the run deterministically.

## 11. State Isolation

All of the following are created inside the child and become unreachable when it exits:

- `ExecutionContext`;
- Mastra workflow/run objects;
- executor instances;
- OpenCode client/session handles;
- cancellation controller;
- invocation results and workflow output;
- event emission state.

The CLI may retain only the selected reference, process handle, protocol messages needed for rendering, and final status. A second `seqlane run` must receive a new child and a new run-scoped runtime state.

## 12. Observability Mapping

The runner translates runtime events into the Seqlane event model before transport:

```text
Mastra / Executor / OpenCode
             ↓
       Seqlane runtime
             ↓
        RunnerEvent
             ↓
           Node IPC
             ↓
        CLI renderer
```

The V1 event set is intentionally limited to run and invocation lifecycle events. The protocol must remain extensible without exposing the underlying execution engines.

## 13. Suggested Implementation Modules

The exact file names may change, but responsibilities should remain separated:

```text
libs/seqlane-core/src/
  runner-protocol.ts       # serializable commands, events, guards

libs/seqlane-runtime/src/
  runner/
    main.ts                # child-process entry point
    protocol.ts            # decode commands, encode events
    load-workflow.ts       # import WorkflowReference
    run-request.ts         # create run and invoke TS-001 runtime

apps/seqlane-cli/src/
  commands/run.ts          # oclif command
  runner-client.ts         # fork, send, receive, lifecycle
  render-events.ts         # CLI projection
  signals.ts               # cancellation forwarding
```

The CLI package must live under `apps/`. It remains a private library package for Nx catalog purposes, so it does not declare or create a deployable service.

## 14. Tests

### Protocol tests

Verify command and event guards, JSON serialization, rejection of unknown fields/types where required, and error serialization without causes or SDK objects.

### Runner tests

Using a fixture workflow and fake executor, verify that the child imports and builds the workflow, emits lifecycle events, returns a serialized result, and exits after a terminal event.

### CLI supervisor tests

Verify fresh child launch, initial request delivery, event rendering, terminal outcome mapping, unexpected child exit handling, and absence of Mastra imports/state in the CLI package.

### Cancellation tests

Exercise SIGINT/SIGTERM forwarding through the real child boundary. Verify executor abort, `run.cancelled`, bounded hard-termination fallback, and continued availability of the external OpenCode server.

### Isolation and contract tests

Run the same workflow twice and verify distinct child/run identities and no state sharing. Run the Renovate-shaped TS-001 fixture through the child boundary using mocked OpenCode execution.

## 15. Acceptance Criteria

TS-002 is complete when:

- `seqlane run` launches one fresh foreground Node runner for each invocation;
- the CLI sends a serializable `RunRequest` containing a workflow reference, input, and OpenCode connection, not a Plan or executable object;
- the runner imports the workflow and builds/validates the Plan itself;
- Mastra, executor, OpenCode, and execution state are absent from the CLI process;
- the runner emits the defined Seqlane-owned lifecycle events over the process boundary;
- all transported messages and successful results are JSON-serializable;
- errors crossing the boundary are normalized and do not include raw causes or engine types;
- the CLI renders structured events and maps success, failure, cancellation, and process failure to defined exit statuses;
- SIGINT/SIGTERM forwards cancellation through the runner to the active executor;
- graceful cancellation leaves the external OpenCode server running;
- the runner exits after every terminal outcome and is never reused;
- the runner performs no user interaction after startup;
- the child-boundary contract test executes the Renovate-shaped workflow end to end.

## 16. Explicitly Deferred

TS-002 does not implement:

- a persistent Seqlane daemon;
- detached or background runs;
- remote runners;
- durable or resumable execution;
- a human-interaction protocol;
- persistent Run Records or a local inspector;
- full OpenCode event capture or OTEL export;
- parallel execution, branches, loops, or retries;
- Seqlane-managed OpenCode startup/shutdown;
- cross-run Work continuation;
- transport alternatives to Node IPC.

## 17. Source Decisions

- ADR-002 defines the dedicated process and ownership boundary.
- RFC-001 defines package boundaries, autonomous execution, cancellation, runner protocol intent, and exit responsibilities.
- RFC-002 defines Seqlane-owned structured events and the CLI projection boundary.
- MVP defines the V1 command/event shapes and the single-run, external-OpenCode profile.
- TS-001 defines the runtime invoked inside the runner.
