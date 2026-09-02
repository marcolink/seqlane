# TS-007 — Work, Run, and Invocation Identity Model

**Status:** Implemented
**Implements:** ADR-007
**Depends on:** TS-001, TS-002, TS-003, TS-008
**Scope:** MVP identity foundation

## 1. Objective

Make Seqlane execution correlation unambiguous without adding persistence, continuation, or Git provenance. Every MVP runner execution creates one Seqlane-owned Work and one distinct Seqlane-owned Run. Each task-node execution in that Run receives a Seqlane-owned Invocation ID.

```text
Workflow ID / Task ID  = reusable definitions
Plan node ID           = static Plan address
Work ID                = logical objective
Run ID                 = one runner-process execution
Invocation ID          = one concrete task-node execution in that Run
```

The initial one-to-one Work → Run relationship is an implementation profile, not an equivalence of the two identities.

## 2. Normative Invariants

- Work, Run, and Invocation are opaque, Seqlane-owned execution identities. Task, Workflow, and Plan node IDs are not substitutes.
- A runner allocates exactly one Work ID and one Run ID for an accepted `run.start`; they are distinct values and remain stable until the terminal event.
- The MVP creates a new Work for every new Run. It has no selector, persistence, lookup, or continuation interface.
- Every execution of a static task node receives one Invocation ID unique within the Run. The same static node in a later Run receives a different Invocation ID.
- A serialized Plan contains no Work, Run, or runtime Invocation ID. It contains stable Plan-node addresses only.
- Plan binding references and dependency edges address Plan nodes, not runtime Invocations.
- Every lifecycle event carries its applicable execution hierarchy: Run events carry Work ID and Run ID; invocation events additionally carry Invocation ID; `invocation.started` also carries Task ID.
- Runner IPC validates the full identity shape and rejects missing, empty, unknown, or non-serializable identity fields.
- No Mastra, executor, session, Git, or provider identity enters core contracts, Plans, workflow authoring, or runner IPC.

## 3. Static Plan Addresses

TS-003 currently uses `invocationId` for deterministic Plan construction and binding resolution. That value is a static address such as `task:1`; it repeats when the Plan is built in another Run and therefore cannot satisfy ADR-007's execution-identity definition.

Replace that Plan-only meaning with a `PlanNodeId` (the concrete field may be `nodeId`). `TaskNode`, `ValueBinding`, `ValueRef`, dependency edges, plan validation, binding resolution, and the in-memory Plan result map use this static address. The public task-invocation result must expose the same Plan-address concept rather than name it an execution Invocation ID.

This is a deliberate breaking change. Do not retain aliases that let callers treat a Plan-node address as a runtime Invocation ID.

```ts
type PlanNodeId = string
type WorkId = string
type RunId = string
type InvocationId = string

interface TaskNode {
  readonly type: "task"
  readonly taskId: TaskId
  readonly nodeId: PlanNodeId
  readonly input: ValueBinding
  readonly dependsOn: readonly PlanNodeId[]
}

interface InvocationStartedEvent {
  readonly type: "invocation.started"
  readonly workId: WorkId
  readonly runId: RunId
  readonly invocationId: InvocationId
  readonly taskId: TaskId
}
```

`PlanNodeId` remains deterministic per Plan build as TS-003 requires. `InvocationId` is allocated only for execution; it must not be derived from, serialized with, or stored back into the Plan.

## 4. Core Event and IPC Contract

`@seqlane/core` owns the execution-identity types, lifecycle-event shapes, serializable runner-event shapes, guards, and encoders. The identities are non-empty strings at the wire boundary; generation stays private to runtime.

All `run.started`, `run.succeeded`, `run.failed`, and `run.cancelled` events contain `workId` and `runId`. All `invocation.started`, `invocation.succeeded`, and `invocation.failed` events contain `workId`, `runId`, and `invocationId`; `invocation.started` also contains the static `taskId` definition identity.

`RunRequest` remains unchanged. In particular, the MVP does not add `workId`, `--work`, a continuation flag, or a client-selected execution ID. The runner remains the authority that creates execution identity after it accepts a valid request.

## 5. Runtime Allocation and Propagation

The private runner allocates the Work and Run before it emits `run.started`, including before workflow loading, Plan validation, profile resolution, or task execution. Thus every post-acceptance load, validation, cancellation, and runtime failure has a correlation hierarchy.

The compiler receives the Work/Run pair through its private execution context. For each ordered Plan node, it allocates and retains a runtime Invocation ID before emitting the node's first lifecycle event. The context maps `PlanNodeId` to the corresponding Invocation ID for the lifetime of that Run. It uses the static node ID for binding resolution and the runtime Invocation ID for lifecycle events and executor requests.

The compiler and runner expose only Seqlane-owned values to the event bridge. Mastra run IDs, step IDs, executor identifiers, session IDs, and private profile details remain implementation state.

## 6. CLI and Process Boundary

The runner event bridge preserves every identity field unchanged while serializing errors and output. CLI supervision decodes only the validated Seqlane event and retains the complete event for callers and projections. Human-readable output may show concise identifiers, but it must not invent, recompute, omit from the structured event, or use Task ID as a correlation key.

No command, configuration, or documented runtime option selects an existing Work. No Git trailer is injected and no commit SHA is collected.

## 7. Package Responsibilities

| Package | Responsibility |
| --- | --- |
| `@seqlane/core` | Identity type vocabulary; Plan-node addressing; lifecycle and runner IPC contracts plus guards. |
| `@seqlane/runtime` | Private ID allocation, execution context, node-to-invocation mapping, event emission, and runner forwarding. |
| `seqlane` | Validated event supervision and presentation only; no identity allocation or execution state. |
| `@seqlane/fixtures` | Deterministic identity factories and contract fixtures for unit/integration tests. |

## 8. Required Tests

- Core authoring and Plan tests prove Plan-node addresses remain deterministic, unique within a build, and contain no execution identity.
- Protocol tests round-trip every identity-bearing event and reject missing, empty, extra, or invalid identity fields.
- Runtime tests prove a Run emits one stable Work/Run pair, maps each static node to one runtime Invocation ID, and passes that Invocation ID to the private executor request.
- Two executions of the same workflow prove new Work, Run, and Invocation identities even when their Workflow, Task, and Plan-node IDs match.
- Failure and cancellation tests prove all terminal events retain the initiating Work/Run pair; invocation failures retain the corresponding Invocation ID.
- Runner/CLI integration tests prove the process boundary preserves the validated fields and CLI supervision does not allocate or infer them.
- Boundary tests prove Plans, workflow authoring, CLI flags, documented configuration, and public core contracts contain no continuation, persistence, Git-provenance, or executor-specific feature.

## 9. Acceptance Criteria

TS-007 is complete when:

- static Plan-node addressing is distinct from Work, Run, and runtime Invocation identity;
- every accepted MVP run emits one stable, distinct Work/Run pair from start through its single terminal event;
- every task-node execution emits a runtime Invocation ID unique to that Run;
- lifecycle events and runner IPC carry and validate the defined correlation hierarchy;
- repeated execution of an unchanged Plan never reuses runtime identity;
- Task ID remains descriptive provenance only and is never treated as an execution correlation key; and
- all workspace quality gates pass without adding persistence, continuation, Git provenance, or executor leakage.

## 10. Explicitly Deferred

- persistent Work, Run, Invocation, or artifact records;
- selecting or continuing Work across Runs;
- Work lookup, lifecycle, retention, or user-facing inspection;
- nested-workflow invocation allocation beyond the MVP static task DAG;
- Git trailers, commit-SHA capture, reverse provenance queries, or commit hooks;
- timestamps, tracing export, session/checkpoint identity, retries, replay, and external identity authority.

## 11. Delivery Order

1. Separate static Plan-node addressing from runtime Invocation identity.
2. Establish the identity-bearing core contracts and allocate them in the private runtime and runner.
3. Preserve the hierarchy through the event bridge, CLI supervision, and child-process boundary.
4. Verify repeated-run isolation, failure/cancellation correlation, docs, and regression boundaries.

## 12. Source Decisions

- [ADR-007 — Distinguish Work, Run, and Invocation Identity](ADR-007-work-run-invocation-identity-model.md) defines the canonical hierarchy and MVP exclusions.
- [RFC-001 — Seqlane Technical Architecture](RFC-001-seqlane-technical-architecture.md) assigns execution identities and structured events to Seqlane-owned contracts.
- [MVP — Seqlane](MVP.md) defines one fresh runner process per execution and excludes persistent Work, cross-run continuation, and Git provenance.
- TS-001, TS-002, TS-003, and TS-008 define the current runtime, runner, Plan, and executor-neutral boundaries this migration updates.
