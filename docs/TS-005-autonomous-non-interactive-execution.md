# TS-005 — Autonomous Non-Interactive Execution

**Status:** Implemented
**Implements:** ADR-005
**Depends on:** TS-001, TS-002, TS-004
**Scope:** MVP

## 1. Objective

Make autonomous, non-interactive execution an explicit Seqlane runtime contract.

After `seqlane run` accepts a valid request, a Run ends only in success, failure, or cancellation. It never requests a human decision.

```text
CLI input before start
        ↓
RunRequest
        ↓
autonomous runner and executor work
        ↓
success | failure | cancellation
```

The existing TS-001, TS-002, and TS-004 paths provide cancellation, JSON-only IPC, and OpenCode interaction rejection. This TS defines the shared policy and closes setup-time gaps.

## 2. Normative Invariants

- The initial `RunRequest` contains all workflow input and connection data for the Run.
- `run.cancel` is the only command accepted after `run.start`.
- Runner commands and events contain no interaction response, option-selection, or resume message.
- The CLI does not import workflows for execution, supply task decisions, parse executor transcripts, or read responses from standard input.
- The runner does not read from standard input or open a terminal interaction path.
- An executor either completes autonomously or fails when it requires unsupported interactive input.
- An interaction requirement is a normal task failure. It maps to the existing Seqlane `ExecutorError` category and then to `invocation.failed` and `run.failed`.
- Interaction failure is not cancellation. It has CLI exit status `1`, not `130`.
- The error sent across runner IPC contains a stable Seqlane message and task ID. It contains no raw executor request, response, event, interaction payload, or SDK type.
- Seqlane never approves, declines, selects, or otherwise answers an executor interaction request.
- Cancellation remains the only runtime control. It is not task input and it does not resume or alter a workflow decision.
- A cancellation accepted before or during runner preparation prevents later task work. Setup code must receive that cancellation signal.
- No automatic retry is added. One invocation makes one executor attempt.
- The policy applies to all executors. OpenCode is the MVP implementation of the policy.

## 3. Interaction Failure Contract

`@seqlane/core` defines a Mastra-independent error that executor adapters use when work cannot continue without a person.

```ts
type InteractionRequirement =
  | "user-input"
  | "confirmation"
  | "option-selection"

class InteractionRequiredError extends Error {
  readonly requirement: InteractionRequirement
}
```

The error has a stable, safe message. It does not contain the raw request, prompt text, interaction payload, or executor error.

An executor throws this error instead of opening an interaction channel. TS-001 normalizes it through the existing executor failure path:

```text
executor detects interaction requirement
        ↓
InteractionRequiredError
        ↓
ExecutorError for the active task
        ↓
invocation.failed
        ↓
run.failed
        ↓
CLI exit 1
```

No new public runner event or command is added. Existing serialized error fields remain the complete runner failure surface.

## 4. Runner Preparation and Cancellation

Runner setup can import a workflow, build a Plan, create an executor registry, and create an external session before `ActiveWorkflowRun` exists. This work must observe cancellation.

The runtime gives an `AbortSignal` to the runner-execution factory. The factory gives that signal to setup work that can create external state. Existing two-argument factories remain valid because the signal is an added final argument.

```ts
type RunnerExecutionFactory = (
  input: JsonValue,
  connection: OpenCodeConnection,
  signal: AbortSignal,
) => Promise<RunnerExecution>
```

The runner creates one run-scoped `AbortController` before loading the workflow. A `run.cancel` command aborts this controller and cancels an active compiled workflow when one exists.

If cancellation is accepted before a session exists, the OpenCode adapter creates no session. If it is accepted during session creation, the adapter must stop before task submission and the runner must emit one `run.cancelled` event.

The runner does not emit `invocation.started` after it accepts a cancellation that prevents task execution.

## 5. OpenCode Policy Mapping

The OpenCode adapter must use the shared interaction failure contract for every supported unresolved interaction signal. It must not call OpenCode endpoints that answer runtime interactions.

The adapter must:

1. detect the supported OpenCode interaction result
2. discard raw OpenCode interaction data
3. throw `InteractionRequiredError` with a safe requirement kind
4. let the Seqlane runtime emit the normal failure lifecycle events

OpenCode cancellation remains separate. The adapter sends one abort request for an active Run session. It does not delete the session or stop the external server.

## 6. CLI and Protocol Boundary

The existing protocol remains closed:

```text
CLI → runner
  run.start
  run.cancel

runner → CLI
  lifecycle events
  terminal result or failure
```

The command parser validates workflow input and the OpenCode URL before it starts a child runner. After startup, the CLI renders events and forwards operating-system cancellation only.

The CLI must reject unknown command shapes. It must not add flags or prompts for executor permission, response, confirmation, or user input.

## 7. Required Tests

Tests must cover:

- strict rejection of interaction-shaped runner commands and events
- a stable `InteractionRequiredError` message without raw executor content
- runtime conversion of that error to existing invocation and Run failure events
- downstream work stopping after interaction failure
- CLI exit status `1` for interaction failure and `130` for cancellation
- one cancel command for repeated operating-system signals
- cancellation before executor setup and during external session setup
- no session or task prompt after cancellation prevents setup
- OpenCode interaction signals that produce no response API call
- no new runner IPC message type and no standard-input read in Seqlane code
- a Renovate-shaped workflow through the actual child-runner boundary

Use deterministic fake executors and a fake OpenCode server. The tests must not require a live model, a human response, or a terminal prompt.

## 8. Acceptance Criteria

TS-005 is complete when:

- Seqlane has one shared, Mastra-independent interaction failure contract
- every executor can fail an unresolved interaction through the existing executor failure path
- no Seqlane runner command or event represents a human response
- the CLI and runner perform no terminal interaction after `run.start`
- interaction failure emits `invocation.failed` and `run.failed` with exit status `1`
- cancellation remains the sole runtime control and has exit status `130`
- cancellation prevents setup-time session creation or task submission when it arrives in time
- OpenCode never answers a runtime interaction request
- raw executor interaction data does not cross core, runtime, runner IPC, or CLI boundaries
- the representative workflow proves success, interaction failure, and cancellation through the child-runner path

## 9. Explicitly Deferred

TS-005 does not implement:

- a human-in-the-loop workflow mode
- runtime approval, question answers, confirmation, or option selection
- a bidirectional interaction protocol
- runner pause, resume, persistence, or durable workflow state
- interactive terminal UI, stdin reads, or prompts
- automatic retry or retry decisions
- managed OpenCode lifecycle or per-task runtime permission configuration
- new executor types, model profiles, or Harness Overlay capabilities

## 10. Delivery Order

1. Define the shared interaction failure contract and keep protocol shapes closed.
2. Propagate cancellation through runner preparation.
3. Normalize interaction failure through the Seqlane runtime.
4. Apply the policy to the OpenCode adapter.
5. Prove autonomous behavior through the CLI and representative workflow.
