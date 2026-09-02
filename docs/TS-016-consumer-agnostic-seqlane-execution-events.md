# TS-016 — Consumer-Agnostic Seqlane Execution Events

**Status:** Accepted
**Implements:** ADR-016
**Depends:** TS-001, TS-002, TS-003, TS-007, TS-011, TS-013
**Scope:** Canonical execution events, event consumers, and static Plan snapshots

## 1. Objective

Move the canonical serialized Seqlane execution-event contract into a
consumer-agnostic package. Connect the CLI to multiple ordered consumers, add
a static `run.plan` event for complete graph initialization, and keep output,
Studio, recording, and future observability projections independent.

```text
runtime execution
      ↓
@seqlane/events
      ↓
CLI event dispatcher
  ├── seqlane-output
  ├── Studio
  ├── recorder
  └── future observability adapters
```

The change must not alter workflow authoring semantics, Plan execution,
executor boundaries, runner exit-status behavior, or Studio's read-only
boundary.

## 2. Normative Terms

- **Runtime event:** An internal event emitted by Seqlane runtime execution
  before serialization. It may contain runtime-only error objects and is not a
  persistence or consumer contract.
- **Execution event:** A JSON-serializable, metadata-bearing
  `SeqlaneExecutionEvent` emitted by the runner and consumed by downstream
  projections.
- **Consumer:** A component that receives the ordered execution-event stream
  and creates a projection, recording, export, or diagnostic side effect.
- **Plan snapshot:** A redacted static topology descriptor associated with one
  Run. It describes possible Plan nodes, not actual invocation instances.
- **Invocation:** One actual execution instance identified by `invocationId`.
- **Plan node:** One static Plan address identified by `planNodeId`.

## 3. Package Ownership

Create a public package:

```text
libs/seqlane-events
@seqlane/events
```

The package owns the canonical execution-event contract, metadata, guards,
JSON event encoding/decoding, Plan snapshot types, and the generic consumer
interface.

Package boundaries:

| Package | Owns | Must not own |
| --- | --- | --- |
| `seqlane-core` | Workflow authoring, Plan IR, shared IDs/primitives, runner commands | Mastra, Studio, terminal rendering, canonical execution-event projections |
| `seqlane-events` | Canonical serializable events, metadata, validation, event encoding, consumer contract | Runtime execution, Mastra, OpenCode, Studio, terminal rendering, OTel SDKs |
| `seqlane-runtime` | Private execution, internal runtime events, projection to canonical events | Public executor-specific event fields |
| `seqlane-output` | Human, CI, and JSON event projections/renderers | Generic fanout, runner transport, Studio, recording, process lifecycle |
| `seqlane-studio` | Studio protocol, registry, browser-facing projection | Runtime execution, canonical event ownership |
| `seqlane-cli` | Runner supervision, consumer wiring, fanout lifecycle, exit status | Workflow execution and consumer-specific reduction |

`seqlane-events` may depend on `seqlane-core` for shared public primitives.
It must not create a dependency cycle. No package may import another package's
relative source or `dist` path.

## 4. Canonical Event Contract

Move the current serialized `RunnerEvent` variants from
`@seqlane/core` into `@seqlane/events` and rename the
canonical type:

```ts
export type SeqlaneExecutionEvent =
  | RunStartedEvent
  | RunPlanEvent
  | InvocationCreatedEvent
  | InvocationProgressEvent
  | InvocationOutputEvent
  | InvocationActivityEvent
  | InvocationInputEvent
  | InvocationResultEvent
  | InvocationRetryingEvent
  | InvocationStartedEvent
  | InvocationSucceededEvent
  | InvocationFailedEvent
  | InvocationSkippedEvent
  | InvocationCancelledEvent
  | RunHeartbeatEvent
  | RunSucceededEvent
  | RunFailedEvent
  | RunCancelledEvent;
```

Canonical events must carry required runner metadata:

```ts
export interface SeqlaneExecutionEventMetadata {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
}
```

`sequence` is strictly increasing within one Run. `eventId` is unique within
one Run. `occurredAt` is an absolute UTC timestamp. Trace context is optional
and follows W3C Trace Context syntax; Seqlane Work, Run, and Invocation IDs
remain the domain correlation identifiers.

The package must provide:

```ts
export function isSeqlaneExecutionEvent(
  value: unknown,
): value is SeqlaneExecutionEvent;

export function encodeSeqlaneExecutionEvent(
  event: SeqlaneExecutionEvent,
): string;

export function decodeSeqlaneExecutionEvent(
  encoded: string,
): SeqlaneExecutionEvent;
```

All encoded values must be JSON-safe. Runtime errors, display values, Plan
snapshots, and outputs must use their existing Seqlane-owned serialized
contracts. Unknown fields remain rejected at the canonical protocol boundary
unless a later compatibility decision adds explicit extension fields.

The old `RunnerEvent` name must not remain the primary public contract. Since
breaking changes are allowed, compatibility aliases are optional and must not
create duplicate definitions.

## 5. Static Plan Snapshot Event

Add one canonical event:

```ts
export interface RunPlanEvent {
  readonly type: "run.plan";
  readonly metadata: SeqlaneExecutionEventMetadata;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly plan: SeqlanePlanSnapshot;
}
```

The snapshot is graph-focused and redacted:

```ts
export interface SeqlanePlanSnapshot {
  readonly workflow: WorkflowIdentity;
  readonly nodes: readonly SeqlanePlanNodeSnapshot[];
}

export interface SeqlanePlanNodeSnapshot {
  readonly planNodeId: PlanNodeId;
  readonly type:
    | "task"
    | "validation.check"
    | "validation.gate"
    | "repeat";
  readonly label: string;
  readonly taskId?: string;
  readonly dependsOn: readonly PlanNodeId[];
  readonly parentPlanNodeId?: PlanNodeId;
  readonly siblingOrder: number;
  readonly maximumIterations?: number;
}
```

The snapshot must include top-level nodes and nested repeat-body nodes. Nested
nodes use `parentPlanNodeId` for static containment. Static dependencies use
Plan-node IDs. Runtime invocation dependencies continue to use Invocation IDs.

The runner emits `run.plan` only after it has loaded, validated, and compiled
the actual Plan. The event is emitted before static invocation topology events:

```text
run.started
run.plan
invocation.created*
invocation.progress*
```

If workflow loading or compilation fails first, the Run may have no
`run.plan`; Studio must render the Run as incomplete rather than infer a Plan.

The event must not include:

- literal input or output values;
- serialized bindings beyond the topology needed for graph edges;
- task schemas or callbacks;
- validator callbacks;
- executor, Mastra, OpenCode, session, prompt, tool, or credential data.

## 6. Runtime Projection

The runtime remains the source of canonical event meaning. It will:

1. retain internal runtime event handling for execution;
2. build `SeqlanePlanSnapshot` from the compiled, validated Plan;
3. emit a runtime plan event before `invocation.created` topology events;
4. project runtime errors to serialized Seqlane errors;
5. add canonical metadata in the runner event bridge; and
6. send only canonical execution events across IPC.

The internal runtime event contract may move from public `seqlane-core` types
to a private runtime module. It must not leak Mastra or executor details into
`seqlane-events`.

Current top-level `invocation.created` events remain. They represent actual
invocation instances and continue to carry `planNodeId`. Repeat-body
invocations continue to be created dynamically with `parentInvocationId` and
iteration data.

## 7. Consumer Contract and CLI Fanout

Add this contract to `seqlane-events`:

```ts
export interface SeqlaneExecutionEventConsumer {
  consume(event: SeqlaneExecutionEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Consumers must receive events in canonical sequence order. The CLI dispatcher
must:

- preserve ordering independently for each consumer;
- prevent one consumer's queue or failure from blocking runner supervision;
- report one bounded diagnostic per failing consumer;
- stop forwarding only to the failed consumer;
- await all consumer flushes after the runner reaches a terminal state; and
- close all consumers before CLI shutdown.

`seqlane-output` remains renderer-specific:

```ts
interface ExecutionRenderer {
  handle(event: SeqlaneExecutionEvent): void;
  finish(): Promise<void>;
}
```

The CLI may wrap this contract as a generic consumer. The package name remains
`@seqlane/output`.

Initial consumers:

- terminal/CI/JSON renderer;
- best-effort Studio publisher;
- recording writer for record/replay; and
- no OpenTelemetry or CloudEvents implementation in this specification.

## 8. Studio Projection

Studio protocol types switch from `RunnerEvent` to
`SeqlaneExecutionEvent`. `StudioIngestEvent` remains a Studio-specific
transport envelope and must not become canonical.

Add an optional Plan snapshot to `StudioRunSnapshot`:

```ts
interface StudioRunSnapshot {
  readonly summary: StudioRunSummary;
  readonly cursor: number;
  readonly plan?: StudioPlanSnapshot;
  readonly invocations: readonly StudioInvocationSnapshot[];
}
```

The registry stores the Plan snapshot from `run.plan`. The browser projection
applies it before invocation events. The graph renderer must keep these
identities separate:

```text
static node:      planNodeId
actual instance:  invocationId
```

The graph must not create synthetic invocation IDs for planned nodes. Planned
nodes render as not-yet-instantiated. Actual invocation events attach state to
their `planNodeId`. Repeated invocations may share a Plan node and remain
distinct actual instances.

Static Plan edges use `dependsOn`. Runtime instance edges use
`dependencyIds`. The browser must not substitute one identity for the other.

## 9. Recording and Replay

The recording format stores the complete canonical event stream, including
`run.plan`. Recordings must not capture a separate Studio-specific event
format.

Replay must rebuild the same Studio projection from the event prefix. A replay
with only `run.started` and `run.plan` must still show the full planned graph.
Replay remains inspection-only and must not load or execute the workflow.

## 10. Standards Adapters

The canonical package has no OpenTelemetry or CloudEvents dependency.

Future OpenTelemetry adapters may map:

- Run to a root span;
- Invocation to a child span;
- lifecycle details to span events or logs; and
- metrics to OTel metrics or span attributes.

Future CloudEvents adapters may wrap canonical events for external transports.
CloudEvents fields must be derived from Seqlane metadata and must not replace
the Seqlane event payload.

Standards references:

- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [OpenTelemetry Tracing API](https://opentelemetry.io/docs/specs/otel/trace/api/#add-events)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)

## 11. Security and Data Handling

- Redaction and display bounds occur before canonical events cross the runner
  boundary.
- `run.plan` must not contain raw binding literals or executor data.
- Recording is explicit local developer behavior and must warn that bounded
  execution data is written to disk.
- No event consumer may log raw credentials, tokens, prompts, or unrestricted
  executor transcripts.
- `invocation.activity` exposes bounded tool and skill lifecycle metadata. Tool
  and skill input, output, and executor metadata include bounded root values by
  default and may use the task's field-selected display policy or explicit
  omission. A skill activity means the executor loaded that skill; it does not
  prove that the instructions were followed.
- Studio remains loopback-only and read-only.

## 12. Required Tests

### Package and protocol

- event variants round-trip through JSON encoding and decoding;
- metadata rejects invalid sequence, timestamp, event ID, and trace context;
- `run.plan` rejects malformed node IDs, duplicate nodes, invalid dependencies,
  and unbounded/raw fields;
- canonical events contain no Mastra or executor types;
- package boundaries use declared dependencies and exports.

### Runtime

- the actual compiled Plan produces one sanitized `run.plan` event;
- `run.plan` precedes invocation topology events;
- nested repeat-body nodes appear in the snapshot;
- runtime failure before Plan compilation emits no fabricated Plan;
- existing invocation event ordering remains unchanged after `run.plan`.

### CLI consumers

- output, Studio, and recording consumers receive the same ordered events;
- a failed consumer does not change runner outcome or CLI exit status;
- one consumer's backpressure does not reorder another consumer;
- all consumers flush and close before normal CLI shutdown.

### Studio and replay

- Studio stores and returns the Plan snapshot;
- browser projection renders planned nodes before invocation events;
- static Plan IDs and invocation IDs remain distinct;
- repeated invocations sharing a Plan node remain distinct;
- replay from `run.started` + `run.plan` renders the complete graph;
- replay final state matches live projection final state.

## 13. Acceptance Criteria

TS-016 is complete when:

- `@seqlane/events` owns the canonical serialized execution-event
  contract;
- CLI output, Studio, and recording consume the same event union;
- `seqlane-output` remains a renderer package with its existing name and
  output responsibilities;
- a real run emits a sanitized `run.plan` event before invocation topology;
- Studio can render the complete static graph before actual invocation state;
- Plan-node and Invocation identities remain separate throughout projection;
- recording/replay preserves the Plan snapshot and all execution events; and
- no Mastra, OpenCode, executor, credential, or raw prompt data crosses the
  canonical consumer boundary.

## 14. Explicitly Deferred

- OpenTelemetry exporter implementation;
- CloudEvents transport implementation;
- external event broker or remote subscription service;
- persistent database-backed event history;
- workflow resumption or execution continuation from recordings;
- raw executor transcript persistence;
- unrestricted tool/MCP payload streaming;
- cross-run comparison and Plan diff UI;
- generic plugin discovery for third-party consumers.

## 15. Delivery Order

1. Bootstrap `@seqlane/events` and move canonical event contracts.
2. Project runtime events and `run.plan` into the new contract.
3. Add the CLI dispatcher and migrate `seqlane-output`.
4. Migrate Studio protocol, registry, and browser projection.
5. Add recording/replay integration.
6. Add boundary, protocol, consumer-isolation, and end-to-end tests.
7. Update package, CLI, Studio, and architecture documentation.

## 16. Source Decisions

- [ADR-016 — Consumer-Agnostic Seqlane Execution Events](ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [ADR-002 — Dedicated Runner Process](ADR-002-dedicated-runner-process.md)
- [ADR-011 — Dedicated Seqlane Output Package](ADR-011-dedicated-seqlane-output-package.md)
- [ADR-013 — Local Read-Only Execution Studio](ADR-013-local-read-only-execution-studio.md)
- [RFC-002 — Execution Observability and Debugging](RFC-002-execution-observability-and-debugging.md)
