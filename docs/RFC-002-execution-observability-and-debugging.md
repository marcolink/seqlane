# RFC 2 — Seqlane Execution Observability and Debugging

**Status:** Draft  
**Depends on:** RFC 1 — Seqlane Technical Architecture

## 1. Purpose

This RFC defines the observability and debugging model for Seqlane execution.

It specifies the structured execution information Seqlane must retain and expose so that a run can be understood without relying on terminal logs or raw executor transcripts.

## 2. Core Principles

1. **Logs are not the source of truth.** Structured execution data is.
2. **One execution model powers all surfaces.** CLI output, future local UI, CI artifacts, programmatic inspection, and external observability integrations consume the same semantic model.
3. **Provenance is first-class.**
4. **Waiting and scheduling decisions must be explainable.**
5. **Sensitive values must be redacted before persistence or export.**
6. **The observability model is Seqlane-owned.** Mastra and OpenCode events are translated into Seqlane concepts.

## 3. Questions the Model Must Answer

For every value: **Where did this value come from?**

For every invocation: **Why did it run, wait, retry, skip, fail, or get cancelled?**

For every run: **What path actually executed?**

For every external/AI task: **What happened inside the executor, and how is that activity correlated to the Seqlane invocation?**

## 4. Logical Run Record

```ts
interface RunRecord {
  run: RunMetadata
  plan: SerializedPlan
  events: SeqlaneEvent[]
  invocations: InvocationRecord[]
  artifacts: ArtifactRecord[]
}
```

This is a logical contract, not a decision about physical persistence format. The MVP does not require persistence.

## 5. Identity

Execution records use the RFC 1 hierarchy:

```text
Work
  ↓
Run
  ↓
Invocation
```

A RunRecord must preserve Work ID when available, Run ID, Workflow ID, Plan identity/version, Invocation IDs, and Task IDs.

## 6. Invocation Lifecycle

A typical invocation lifecycle is:

```text
created
  ↓
waiting_dependencies
  ↓
ready
  ↓
waiting_resources
  ↓
waiting_session
  ↓
running
  ↓
validating_output
  ↓
succeeded
```

Alternative states include failed, cancelled, skipped, retry scheduled, and retrying.

Not every state is required in the MVP, but the event model must allow them.

## 7. Seqlane Event Model

Candidate event categories include:

### Run lifecycle

- `RunStarted`
- `RunCompleted`
- `RunFailed`
- `RunCancelled`

### Invocation scheduling

- `InvocationCreated`
- `InvocationWaitingDependencies`
- `InvocationReady`
- `InvocationWaitingResource`
- `InvocationWaitingSession`

### Resource/session lifecycle

- `ResourceAcquired`
- `ResourceReleased`
- `SessionAcquired`
- `SessionReleased`

### Input/output lifecycle

- `InputResolved`
- `InvocationStarted`
- `OutputReceived`
- `OutputValidated`
- `OutputValidationFailed`

### Retry lifecycle

- `RetryScheduled`

### Invocation terminal state

- `InvocationSucceeded`
- `InvocationFailed`
- `InvocationCancelled`
- `InvocationSkipped`

### Executor activity

- `ExecutorEvent`

Exact event names may change, but the semantic categories are required.

## 8. Provenance

Seqlane must preserve provenance for resolved values.

For a resolved input, the model should be able to show resolved value or redacted representation, source invocation/workflow input, reference path, schema, and validation outcome.

Example:

```text
implement.input.plan
  ← create-plan.output.plan
  ← invocation inv_123
```

This must come from Seqlane bindings rather than reconstructed log analysis.

## 9. Plan vs Actual Execution

The system must distinguish the serialized Plan that could execute from the actual path that did execute.

This becomes important once Seqlane supports branches, loops, skips, retries, and repeated invocations.

Historical inspection should retain the actual Plan associated with the Run rather than rebuilding it from current source.

## 10. Timeline

The observability model should support a timeline showing invocation execution duration, concurrency, dependency waiting, resource waiting, session waiting, retries, and executor activity.

The CLI need not render all of this initially.

## 11. Invocation Inspection

A future invocation inspector should be able to expose categories such as Overview, Input, Output, Execution, Agent, Trace, Artifacts, and Logs.

These are UI concepts, not persistence requirements.

## 12. OpenCode Correlation

OpenCode activity must be correlated beneath the Seqlane invocation that caused it.

Relevant information may include session, model, messages, tool calls, shell execution, subagents/child sessions, token usage, and cost where available.

Seqlane should initially consume OpenCode's public event stream and translate it into executor instrumentation. No mandatory Seqlane OpenCode plugin is required unless the public event stream proves insufficient.

For shared sessions, Seqlane's serialization allows top-level correlation through the active invocation/session mapping. Child/subagent sessions should be attributed through parent/child relationships where available.

## 13. Runner Event Boundary

The dedicated Seqlane runner emits structured Seqlane lifecycle events across the process boundary.

```text
Mastra / Executors / OpenCode
             ↓
       Seqlane runtime
             ↓
       SeqlaneEvent
             ↓
            IPC
             ↓
     seqlane-output
             ↓
           oclif
```

The CLI renderer consumes these events but is not their source of truth.

## 14. IPC Is a Transport

Node IPC is only the initial event transport.

```text
SeqlaneEvent
      │
      ├── Node IPC
      ├── future RunRecord
      ├── local inspector
      └── OTEL adapter
```

The semantic event model must remain independent of Node IPC.

## 15. Non-Interactive V1

RFC 2 does not assume a human-interaction protocol.

For V1:

```text
runner ──────────→ CLI
       events/results

CLI ─────────────→ runner
       initial request
       cancellation
```

There are no events that require a human response such as permission approval, user input, or confirmation.

## 16. CLI Projection

CLI output is a projection of structured Seqlane events. Terminal output must
never become the canonical debugging model.

The private `@seqlane/output` package owns event reduction and the
human, CI, and JSON/NDJSON renderers. It consumes only validated Seqlane
events and depends on `seqlane-core`; it does not own runner transport,
execution, or process status.

The CLI selects the renderer with `--output auto|human|ci|json`. Auto mode uses
human output only for an interactive non-CI TTY; CI output is the fallback for
CI and non-TTY execution. Human output may redraw through a TTY, while CI
output is append-only and emits no ANSI or carriage-return control sequences.
JSON mode reserves stdout for one machine-readable event record per line.

The CLI supplies terminal capabilities, output sinks, optional
`GITHUB_STEP_SUMMARY` integration, and resize updates. Renderer write or
finalization errors are reported diagnostically and do not replace the runner's
authoritative success, failure, or cancellation status.

## 17. Persistence

A possible logical on-disk structure is:

```text
.seqlane/runs/<run-id>/
  run.json
  plan.json
  events.ndjson
  invocations/
  artifacts/
```

This is illustrative only. The physical persistence model remains unresolved; SQLite or another local store may be preferable.

Local debugging must not require an external observability service.

## 18. Sensitive Data

Task inputs, outputs, prompts, model activity, shell output, environment data, and artifacts may contain sensitive information.

Redaction must occur before persistence/export rather than relying solely on consumers to hide secrets later.

## 19. Artifacts

Large or binary outputs should be represented as artifacts rather than embedded directly into event streams or metadata documents.

Artifacts must remain correlated to the Work/Run/Invocation that produced them.

Git commits may eventually be represented or correlated as repository artifacts using RFC 1 provenance identities.

## 20. Replay

Replay is post-MVP.

Any future replay mechanism must obey effect safety and distinguish reused upstream outputs, recomputed invocations, and mutating vs non-mutating work. Replay must not blindly rerun destructive work.

## 21. Run Diff and Experiments

Comparing runs and experimentation are post-V1 capabilities. The observability model should not prevent future comparison of Plans, outputs, models, durations, costs, and execution paths.

## 22. Mastra Tooling

Mastra Studio or Mastra tracing may be useful implementation accelerators. They must remain implementation details.

Seqlane observability contracts and source workflows must not depend on them.

## 23. Locked Decisions

- **O1** — Run is a structured inspectable entity.
- **O2** — Seqlane owns the debug/event model.
- **O3** — Stable Run and Invocation identities are required.
- **O4** — Provenance is first-class.
- **O5** — Waiting/resource/session state must be explainable.
- **O6** — CLI/UI/external integrations consume the same semantic model.
- **O7** — OpenCode activity is correlated beneath Seqlane invocations.
- **O8** — Sensitive information is redacted before persistence/export.
- **O9** — Historical runs retain the actual executed Plan.
- **O10** — Mastra tooling remains implementation-only.
- **O11** — Replay must obey effect semantics.
- **O12** — Local debugging must work without an external observability service.
- **O13** — Structured Seqlane events cross the runner boundary.
- **O14** — Node IPC is a transport, not the observability model.
- **O15** — CLI rendering is a projection of structured runtime state.

## 24. MVP Boundary

The ADR-011 output implementation uses a validated runner event subset sufficient
for topology-aware CLI progress and failure reporting:

```ts
type RunnerEvent =
  | RunStarted
  | InvocationCreated
  | InvocationProgress
  | InvocationOutput
  | InvocationRetrying
  | InvocationStarted
  | InvocationSucceeded
  | InvocationFailed
  | InvocationSkipped
  | InvocationCancelled
  | RunHeartbeat
  | RunSucceeded
  | RunFailed
  | RunCancelled
```

Runner-emitted events carry schema version, event ID, sequence, and UTC
timestamp metadata. Output activity is bounded and redacted before it crosses
the runner boundary. `@seqlane/output` consumes this stream; the
CLI remains responsible for selecting a renderer and preserving exit status.

The MVP does not require persistent RunRecord, local visual inspector, OTEL export, timeline UI, replay, diff, persistent artifacts, or full OpenCode event capture.
