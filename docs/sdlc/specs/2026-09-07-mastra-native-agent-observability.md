---
id: spec.mastra-native-agent-observability
title: Native Mastra Agent Observability Projection
status: active
owners:
  - core
created: 2026-09-07
updated: 2026-09-09
upstream:
  - adr.mastra-native-agent-observability
supersedes: []
---

# Native Mastra Agent Observability Projection

## Summary

This specification defines the private Mastra observability contract between
the Mastra-backed runtime and concrete agent adapters. The runtime preserves
Mastra's per-invocation `ObservabilityContext` in
`MastraPlanInvocationContext` and passes it through `AgentAdapterRequest`.
Each concrete adapter owns the translation of its executor's observations into
native Mastra spans.

This specification does not define an executor SDK mapping. Each concrete
adapter has a separate projection specification for its observation contracts,
identities, reducers, and span fields.

## Goals

- Propagate the active Mastra observability context for every invocation.
- Give each concrete adapter ownership of its executor-specific span mapping.
- Define common parentage, lifecycle, and failure-isolation rules.
- Keep executor parsing and correlation inside each concrete adapter.
- Prevent a generic executor-observation union or shared lossy projector.
- Preserve completed spans after later task failure or cancellation.
- Isolate Mastra storage/export failures from execution outcomes.
- Keep public Seqlane boundaries executor-neutral, redacted, and bounded.

## Non-goals

- Making Mastra authoritative for Seqlane execution, workflows, Plans, or
  serialized events.
- Adding Mastra imports or types to `@seqlane/core`, `@seqlane/events`,
  workflow APIs, Plans, or runner IPC.
- Creating a generic runtime `ExecutorObservation` union or generic Mastra
  projector for all executors.
- Defining OpenCode, ACP, or other executor event mappings in this document.
- Replacing Seqlane aggregate invocation metrics or its consumer-agnostic
  event model.
- Persisting raw transcripts, prompts, secrets, or unbounded tool payloads by
  default.
- Defining a new public executor contract or changing executor selection.

## Terminology

- **Observability context:** Mastra's per-invocation context, including the
  current workflow-step span and related tracing state.
- **Execution port:** An adapter-owned client seam for executor operations and
  results. It is not the observability interface.
- **Observability input:** The required per-invocation
  `AgentAdapterRequest.observability` value.
- **Concrete adapter:** A private executor adapter that understands its own
  observation identities and emits native Mastra spans.
- **Projection specification:** The adapter-specific contract that maps one
  executor observation model to Mastra spans.

## Requirements

### R1. Boundary ownership

The public `@seqlane/core` and `@seqlane/events` packages, workflow APIs,
serialized Plans, and runner IPC MUST remain free of Mastra imports, types, and
fields. The private `@seqlane/agent-adapter` contract MAY expose Mastra
observability types. `@seqlane/runtime` already owns the Mastra-backed runtime
integration and MAY use Mastra. A concrete adapter MAY import its executor
client types and the supported Mastra types.

Mastra types MUST NOT leak beyond the private runtime, private agent-adapter
contract, and concrete adapter packages. An adapter MUST NOT expose Mastra
types through workflow authoring, Plans, public events, or runner messages.

### R2. Per-invocation context propagation

Mastra's workflow `ExecuteFunctionParams` extends
`Partial<ObservabilityContext>`. Runtime execution MUST retain those fields in
`MastraPlanInvocationContext` and pass the current invocation context through
to `AgentAdapterRequest`.

`AgentAdapterRequest.observability` MUST be required in the private contract as
`Partial<ObservabilityContext>`. `RuntimeAdapterFactoryContext` is
run/session-scoped and MUST NOT replace the per-invocation context. The runtime
MUST collect the workflow execution's observability fields into that required
request value before invoking the adapter. The value MAY contain no current
span when tracing is disabled or sampled out. The adapter MUST then make
instrumentation a no-op without changing execution.

The runtime MUST preserve Mastra's `tracing` and `tracingContext` aliases. If
both aliases contain a current span, their span IDs MUST match. Adapters MUST
read `tracingContext.currentSpan` first and fall back to
`tracing.currentSpan`. If both values exist and disagree, instrumentation MUST
emit a bounded diagnostic and become a no-op for that invocation.

Conceptually:

```ts
interface MastraPlanInvocationContext {
  // Other private invocation inputs remain unchanged.
  observability: Partial<ObservabilityContext>
}

interface AgentAdapterRequest {
  // Executor-neutral invocation request fields remain private to the adapter
  // boundary.
  observability: Partial<ObservabilityContext>
}
```

The request property itself MUST NOT be optional. When Mastra supplies a
current workflow-step span, the runtime MUST preserve it.

### R3. Span hierarchy and parentage

When present, the concrete adapter MUST use the current Mastra workflow-step
span from the request context as its parent. It MUST NOT synthesize a second
`WORKFLOW_STEP` or treat Mastra as a detached external metrics sink. When the
current span is absent, adapter execution continues without native spans.

```text
WORKFLOW_STEP (current Mastra step for this invocation)
  └── AGENT_RUN
        ├── MODEL_GENERATION
        │     └── TOOL_CALL (when the adapter observes model ownership)
        ├── TOOL_CALL (when no model parent is available)
        └── SKILL_RESOLUTION (only for a dynamic resolver run)
```

The current workflow-step parent is the authoritative Work, Run, and Invocation
trace correlation. Adapters MUST NOT copy unavailable Work or Run identifiers
into child spans. The adapter request supplies `invocationId`. An adapter MAY
add its bounded value to `AGENT_RUN` metadata. Child spans inherit correlation
through parentage and add only bounded adapter-owned identities when needed.
A child span MUST NOT become a new Seqlane invocation or alter event ordering.

### R4. Adapter-local projection ownership

Each concrete adapter MUST own its executor parser, lifecycle reducer,
correlation state, and Mastra projector. Its projection specification MUST
define the supported observation source, identity keys, transitions, span
types, fields, and terminal behavior.

An existing execution port remains an executor client seam. The adapter MUST
NOT add Mastra types or span operations to that port. Observability enters
through `AgentAdapterRequest.observability` and leaves through Mastra spans.

Each external observation MUST be validated once. One adapter-local reducer
MUST then fan out lifecycle transitions to existing Seqlane callbacks and the
Mastra projector. A streaming observation source MUST have one consumer. A
callback output MUST NOT become an input to another output path.

### R5. Typed span fidelity

An adapter MUST create a typed span only when its observation contract exposes
the required identity and lifecycle. It MUST NOT infer model generations,
provider identity, token usage, cost, or tool completion from unrelated fields.

Each adapter projection specification MUST map supported executor values to
the exact typed fields of the workspace-pinned Mastra version. Missing values
remain absent. Usage values MUST be numeric, non-negative, and tied to one
observed generation. Cost MUST preserve its source, unit, and precision. An
adapter MUST NOT invent usage, cost, or a model identity.

For `TOOL_CALL`, an adapter MUST use the pinned Mastra typed attributes only
for the typed tool contract: `toolType`, `toolCallId`, and terminal `success`.
Mastra has no typed tool-name attribute. A validated, normalized, bounded tool
identity therefore belongs in the span `name`, not an untyped duplicate
attribute or metadata field. Adapter and correlation details belong only in
bounded namespaced metadata. Each adapter specification MUST define its
tool-name fallback and cardinality limit before it makes names observable.

### R6. Native metrics and aggregate metrics

Mastra MUST derive native duration and usage metrics from completed typed
spans. An adapter MUST NOT submit a second native metric row for the same
lifecycle.

Existing `onMetrics`, `onActivity`, and diagnostic callbacks remain separate
Seqlane outputs. The native projector MUST NOT subscribe to those callbacks.
Metric labels and correlation values MUST follow Mastra's cardinality
protections and the field policy in the adapter projection specification.

### R7. Span lifecycle and failure handling

The concrete adapter MUST start and end typed spans at observed lifecycle
boundaries. It MUST end `AGENT_RUN` when the adapter invocation reaches its
terminal outcome and MUST not close the workflow-step span owned by Mastra's
workflow runtime.

Completed child spans MUST remain complete if the enclosing task later fails or
is cancelled. On task failure, cancellation, or an observed executor
disconnect, any open span MUST close with an error or cancellation status and
bounded failure metadata. An adapter shutdown has this requirement only when
its private contract exposes an observable disposal lifecycle. Repeated
terminal signals MUST be idempotent.

Adapters MUST close open spans from leaves to root. They close tool, skill, or
other leaf spans first, then model spans, then `AGENT_RUN`. They MUST never
close the workflow-step span.

### R8. Data minimization

Inputs, outputs, prompts, tool arguments/results, error text, and correlation
metadata MUST be redacted and bounded before entering Mastra spans. Secrets,
credentials, authorization headers, and raw transcripts MUST never be
persisted by default. Message content MUST NOT be used as an identity key.
The same redaction and size policy MUST apply to event and terminal-response
paths.

### R9. Storage, export, and outcome isolation

Mastra storage/export configuration MUST support metrics and the configured
span categories. Sampling MAY intentionally omit spans or derived metrics.

The concrete adapter owns no-throw isolation for synchronous span creation,
update, and closure calls. The Mastra-backed runtime owns storage, export,
sampling, flushing, and dropped-event behavior. The adapter MUST NOT flush,
retry, or shut down the export pipeline. Failures at either boundary MUST use
Seqlane's bounded diagnostic path and MUST NOT block, retry, fail, or change
the execution outcome.

The runtime MUST verify persisted traces through its configured
`MastraStorageExporter`; deterministic span sinks alone do not prove storage
or inspection visibility. A remote platform exporter MUST NOT be configured by
default unless it is confirmed to satisfy the repository's Community-only
runtime policy and has an explicit operational owner.

### R10. Compatibility

The change MUST be additive to existing aggregate invocation metrics and
consumer-agnostic events. Public events, Plans, workflow authoring, and runner
IPC schemas MUST NOT gain Mastra-specific fields or dependencies. Existing
consumers MUST continue to operate with the private context propagation.

## Detailed design or contracts

### Invocation context propagation

Mastra `ExecuteFunctionParams` extends `Partial<ObservabilityContext>`. These
flattened observability fields are the source of the current workflow-step
context. The runtime MUST collect them in the private
`MastraPlanInvocationContext` for the invocation. When building an
`AgentAdapterRequest`, it MUST pass them as the required
`request.observability` value.

The adapter factory MAY receive `RuntimeAdapterFactoryContext` for run/session
configuration, connection state, and cancellation. It MUST receive the
per-invocation `AgentAdapterRequest.observability` for span parentage. Factory
context MUST NOT be used to cache the active workflow-step span across
invocations.

### Common component execution order

The runtime prefix and suffix are common to every concrete adapter. The middle
belongs to the adapter projection specification.

```text
Mastra WORKFLOW_STEP
  -> Mastra step execute parameters
  -> MastraPlanInvocationContext.observability
  -> runtime admission and adapter resolution
  -> AgentAdapter.execute(request.observability, callbacks)
  -> optional adapter-local admission
  -> adapter opens AGENT_RUN under WORKFLOW_STEP
  -> adapter-specific observation flow
  -> adapter closes leaf spans, model spans, then AGENT_RUN
  -> adapter returns the task result
  -> runtime completes the Seqlane invocation
  -> Mastra closes WORKFLOW_STEP
```

The runtime owns the workflow step and the per-invocation context handoff. The
adapter owns `AGENT_RUN` and all descendants. The executor client owns the
external operation. Mastra storage owns span export and metric derivation.

### Current adapter composition

The current concrete agent adapters are OpenCode and ACP v1. The following
sketches show their adapter-specific middle. Their projection specifications
own the exact contracts.

```text
OpenCode adapter
  -> resolve or reuse OpenCodeRun and session
  -> resolve structured-output strategy and build prompt
  -> for each prompt attempt
       -> subscribe once to the OpenCode SDK v2 event stream
       -> submit the prompt
       -> validate each event once
       -> one reducer fans out interaction, activity, and Mastra transitions
       -> reconcile the terminal response with observed spans
       -> emit aggregate onMetrics separately
       -> return output or build a repair prompt
```

```text
ACP v1 adapter
  -> wait for adapter queue admission outside AGENT_RUN
  -> build the prompt and output schema
  -> for each prompt attempt
       -> AcpAgent.stream through the private AcpAgentStream execution port
       -> read and validate each stream chunk once
       -> one reducer fans out activity and Mastra tool transitions
       -> resolve final text and emit aggregate onMetrics separately
       -> return validated output or build a repair prompt
```

An adapter can have a different observation source. It still obeys the common
runtime prefix, span ownership, one-way reduction, and closure order.

### Mastra metric derivation

The adapter MUST use Mastra's typed span categories and fields supported by the
configured Mastra version. Automatic metric names are derived outputs, not a
second hand-written metric contract. Expected outputs include
`mastra_agent_duration_ms`, `mastra_tool_duration_ms`,
`mastra_model_duration_ms`, model token metrics, and cost context attached to
the model/token metrics. A `SKILL_RESOLUTION` trace can have no automatic
duration metric.

### Official sources

The implementation MUST verify field names and lifecycle behavior against the
configured Mastra version and these official references:

- [Mastra metrics overview](https://mastra.ai/docs/observability/metrics/overview)
- [Mastra automatic metrics](https://mastra.ai/reference/observability/metrics/automatic-metrics)
- [Mastra spans reference](https://mastra.ai/reference/observability/tracing/spans)
- [Mastra tracing overview](https://mastra.ai/docs/observability/tracing/overview)

## Failure and edge cases

- **Malformed executor observation:** Apply the adapter projection contract.
  Never create a span from unverifiable data.
- **Unsupported observation:** Diagnose and ignore it when the adapter contract
  permits continuation.
- **Duplicate lifecycle update:** Reconcile it through the adapter reducer.
  Preserve one span and one metric contribution.
- **Missing field:** Omit it. Do not infer usage, cost, identity, or completion.
- **Task failure after model success:** Leave the model span successful and
  mark only still-open spans according to their observed lifecycle.
- **Cancellation:** Complete observed spans, close open spans as cancelled,
  and preserve the Seqlane cancellation outcome.
- **Mastra exporter/storage failure:** Record a diagnostic and continue the
  run. Never convert a task result into an observability error.
- **Sampling:** Configured sampling can omit spans and derived metrics.
  Seqlane aggregate metrics remain the execution record.
- **Redaction overflow:** Truncate or omit the field under the common bound.
  never increase the bound to preserve a payload.
- **Missing current span:** Keep the required observability request property,
  skip native span creation, and continue execution. This covers disabled or
  sampled-out tracing and no-op test contexts.

## Migration

This is an additive private contract. Existing aggregate metrics, public
events, Plans, workflow APIs, and runner IPC remain compatible. The private
`AgentAdapterRequest` gains required per-invocation observability context, and
`MastraPlanInvocationContext` retains the workflow execution context needed to
populate it.

Each concrete adapter adds its own parser, lifecycle reducer, and native span
projector. Existing execution ports remain unchanged. No generic normalized
observation union or generic runtime Mastra projector is introduced.

No migration of historical aggregate metrics or raw transcripts is required.
Existing callers and tests that do not exercise tracing can pass an empty or
no-op context. The request property remains explicit and non-optional.

## Verification

Tests MUST cover observable contracts and boundary behavior:

- `MastraPlanInvocationContext` retains the per-invocation partial context.
- runtime execution passes the collected partial context to
  `AgentAdapterRequest.observability`, while factory context remains
  run/session-scoped.
- current workflow-step parentage is reused and no synthetic workflow step is
  created.
- each adapter has a separate projection specification for its observation
  identities, transitions, typed fields, and edge cases.
- each streaming source has one validated consumer and one reducer that fans
  out transitions without callback feedback loops.
- typed spans use only verified observations and the supported Mastra fields.
- failure, cancellation, and disconnect closure, including completed spans
  surviving later task failure.
- native span metrics and existing aggregate metrics remain separate outputs.
- Mastra span/storage/exporter failure isolation from execution outcomes.
- redaction, bounds, unsupported observations, and malformed payloads.
- boundary tests proving Mastra types do not enter `@seqlane/core`,
  `@seqlane/events`, workflow APIs, Plans, or runner IPC, while private runtime
  and concrete adapter imports remain permitted.

Use Mastra test storage or an equivalent deterministic span sink to assert
typed spans and derived metric inputs. Adapter-specific tests MUST add
compatibility coverage for each external observation contract.

## Acceptance criteria

The specification is complete when:

- each invocation preserves Mastra's `Partial<ObservabilityContext>` through
  `MastraPlanInvocationContext` to the required `AgentAdapterRequest` field.
- each concrete adapter uses the current workflow-step span as parent and does
  not create a synthetic workflow step.
- each adapter-specific projection has one validated observation path and one
  lifecycle reducer.
- typed span fields contain only values verified by that adapter's observation
  contract.
- open spans close with errors on failure, cancellation, or disconnect, while
  completed spans remain intact.
- Mastra export/storage failures do not alter execution outcomes.
- redaction and size bounds prevent default persistence of secrets, prompts,
  raw transcripts, or unbounded payloads.
- existing aggregate metrics, public events, Plan IR, workflow authoring, and
  runner IPC remain compatible and Mastra-free.
- the required tests pass against supported Mastra and adapter observation
  contracts.
- configured Mastra storage/export derives the metrics supported by each
  adapter's typed spans, subject to sampling configuration.

## Traceability

- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [spec.opencode-mastra-observability-projection: OpenCode-to-Mastra Observability Projection](./2026-09-08-opencode-mastra-observability-projection.md)
- [spec.acp-mastra-observability-projection: ACP v1-to-Mastra Observability Projection](./2026-09-07-acp-mastra-observability-projection.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.consumer-agnostic-seqlane-execution-events: Define Consumer-Agnostic Seqlane Execution Events](../adrs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events: Consumer-Agnostic Seqlane Execution Events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [adr.executor-neutral-workflow-authoring: Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
