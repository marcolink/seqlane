---
id: spec.opencode-mastra-observability-projection
title: OpenCode-to-Mastra Observability Projection
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-13
upstream:
  - adr.mastra-native-agent-observability
  - spec.mastra-native-agent-observability
supersedes: []
---

# OpenCode-to-Mastra Observability Projection

## Summary

This specification defines the OpenCode-specific projection from the private
Seqlane adapter to native Mastra spans and derived metrics. It applies to the
OpenCode SDK v2 event contract used by `@seqlane/opencode-adapter`. Other adapters have
separate projection specifications for their own event and lifecycle contracts.

This is not OpenCode SDK observability. The SDK is the validated observation
source. The Seqlane OpenCode adapter owns the projection into Mastra.

The implementation uses `@opencode-ai/sdk` 1.18.27 and `@mastra/core` 1.64.0.
For each prompt attempt, it subscribes once to the OpenCode event stream before
sending the prompt. One validated reducer fans out interaction, activity,
background-process, and native-span transitions. `prompt-response.ts` validates
the terminal response separately and returns one private observation for
identity reconciliation.

`AgentAdapterRequest.observability` supplies the invocation context. The
OpenCode adapter creates typed Mastra child spans when a current workflow-step
span exists. It remains a no-op when tracing is absent or the aliases conflict.

## Goals

- Preserve the per-invocation Mastra context at the private adapter boundary.
- Use one validated event reducer for each OpenCode prompt attempt.
- Fan out each reducer result to interaction handling, existing activity, and
  native Mastra span lifecycle without adding a second event consumer.
- Create one `AGENT_RUN` for the adapter invocation and one
  `MODEL_GENERATION` for each actual assistant message.
- Represent OpenCode tool parts with correctly correlated `TOOL_CALL` spans.
- Reconcile event observations with the terminal response without duplicates.
- Preserve provider, model, token, cache, reasoning, and executor-reported cost
  data when the OpenCode contract provides it.
- Keep Seqlane aggregate metrics and `onActivity` behavior separate from native
  Mastra spans.
- Isolate observability failures from OpenCode execution results.

## Non-goals

- Adding Mastra types to `@seqlane/core`, `@seqlane/protocol`, Plans, workflow
  authoring, serialized events, or runner IPC.
- Defining a generic executor observation union or shared executor projector.
- Replacing Seqlane `onMetrics` aggregate invocation metrics.
- Treating the terminal response as the primary event stream.
- Persisting raw prompts, transcripts, tool arguments, tool results, secrets,
  or unbounded payloads by default.
- Changing OpenCode session, structured-output, cancellation, or interaction
  semantics.

## Terminology

- **Prompt attempt:** One call to `OpenCodeRun.prompt`. A structured-output
  repair is a new attempt in the same executor invocation.
- **Event reducer:** The one adapter-local, validated consumer that reconciles
  OpenCode event identity and lifecycle for one prompt attempt.
- **Assistant message:** One OpenCode v2 `AssistantMessage`, identified by its
  `(sessionID, id)` pair.
- **Tool part:** One OpenCode v2 `ToolPart`, identified by its
  `(messageID, callID)` pair.
- **Terminal fallback:** The validated response from `parseOpenCodePromptResponse`
  used only to complete missing model observation fields or create one model
  span when event coverage is incomplete.
- **Native spans:** Mastra `AGENT_RUN`, `MODEL_GENERATION`, and `TOOL_CALL`
  spans emitted by the private OpenCode adapter.

## Requirements

### R1. Private boundary and context

The runtime MUST retain the invocation's `Partial<ObservabilityContext>` in
its private invocation context and pass it as a required
`AgentAdapterRequest.observability` field. The OpenCode adapter MUST read the
current span from `tracingContext.currentSpan`, falling back to
`tracing.currentSpan` as defined by the generic observability specification.

The current span, when present, MUST parent `AGENT_RUN`. The adapter MUST NOT
create a synthetic workflow-step span. When no current span is available,
native instrumentation MUST be a no-op and execution MUST continue.

Mastra imports and types MUST remain limited to the private runtime, private
agent-adapter contract, and concrete adapter packages.

The supported Mastra contract is `@mastra/core` 1.64.0. The OpenCode adapter
MUST declare it as a direct dependency when it imports observability types or
values.

### R2. One subscription and one reducer per attempt

For every prompt attempt, the adapter MUST:

1. Create the prompt and cancellation controllers.
2. Subscribe exactly once to the OpenCode event stream.
3. Start exactly one validated event reducer over that subscription.
4. Start the prompt request after the subscription is ready.
5. Fan out each validated reducer result to interaction detection, existing
   `onActivity` or background-process handling, and native span projection.

An output consumer MUST NOT subscribe again, iterate the same stream a second time,
or consume another output's transformed events. Interaction handling,
`onActivity`, and native spans are independent reducer outputs. A malformed or
unsupported event is diagnosed and ignored when safe. It MUST NOT crash the
execution or produce an unverifiable span.

The reducer MUST filter events to the current session. It MUST preserve event
ordering within the attempt and reconcile repeated updates by stable identity.
The current implementation already subscribes once before `prompt` and uses a
single consumer for interaction and tool activity. The native projection MUST
extend that consumer through fan-out rather than adding a second subscription.

### R3. Agent run lifecycle

When a current Mastra span exists, the adapter MUST open one `AGENT_RUN` for
each admitted `AgentAdapter.execute` invocation. It MUST open the run before
adapter-local schema conversion, session resolution, or the first prompt
attempt. It keeps the run open across structured-output repairs. The run MUST
include only bounded invocation and adapter metadata. It MUST NOT include
prompt text or raw transcript data.

The run MUST close after the final validated result, interaction failure,
transport failure, cancellation, or observed event-stream closure. Child tool
and model spans MUST close before the run. Close operations MUST be idempotent.
The adapter MUST never close the Mastra workflow-step parent.

The target hierarchy is:

```text
WORKFLOW_STEP (current Mastra span)
  └── AGENT_RUN (one OpenCode executor invocation)
        ├── MODEL_GENERATION (one assistant message)
        │     └── TOOL_CALL (message-owned tool part)
        └── TOOL_CALL (only when no model parent is available)
```

### R4. Assistant-message generations

The primary model source is OpenCode v2 `message.updated`. SDK 1.18.27
exposes an `AssistantMessage` with `id`, `sessionID`, `time.created`,
`time.completed`, `providerID`, `modelID`, `cost`, and token totals. The token
fields cover input, output, reasoning, cache read, and cache write.

The reducer MUST key one `MODEL_GENERATION` by `(sessionID, messageID)`. The
first valid assistant message observation opens the span. Later
`message.updated` events update the same span with lifecycle, usage, provider,
model, and cost fields. A completed or error terminal state closes the span.

Every structured-output repair assistant message MUST receive its own model
span. The adapter MUST NOT aggregate multiple responses into one generation.
Message content MUST NOT be an identity key.

### R5. Tool-part lifecycle and parentage

The primary tool source is OpenCode v2 `message.part.updated`. SDK 1.18.27
exposes a `ToolPart` with `messageID`, `callID`, `tool`, and state and time
fields.

The reducer MUST key one `TOOL_CALL` by `(messageID, callID)`. Repeated part
updates MUST update one span. A tool span MUST be parented under the matching
model-generation span when that generation is known. If no model parent is
available, it MUST be parented directly under `AGENT_RUN`.

Tool status maps to span lifecycle as follows:

| OpenCode state | Native action |
| --- | --- |
| pending or running | Open or update one `TOOL_CALL` |
| completed | End once with success |
| error | End once with failure |
| attempt ends while open | End as incomplete, failed, or cancelled according to the terminal outcome |

OpenCode `skill` parts remain `TOOL_CALL` activity. The adapter uses a bounded
`toolType: "skill"` attribute when the typed Mastra contract supports it. When
the tool input or metadata exposes a non-empty skill `name`, the adapter uses
that validated identity as the `TOOL_CALL` span name. It falls back to the
constant tool name when the identity is missing, oversized, invalid, or beyond
the invocation-local name budget. The skill identity MUST NOT be duplicated in
an untyped attribute or metadata. A skill load MUST NOT become a
`SKILL_RESOLUTION` span. That category is reserved for a separately observed
dynamic skills-resolver lifecycle.

For an ordinary tool part, `toolType` MUST be `"tool"`; it classifies the
operation and is not a place for the executor or protocol identity. The
raw `tool` value MUST be at most 256 UTF-16 code units before normalization.
Longer input MUST use the constant fallback without invoking normalization.
Otherwise, the validated `tool` value MUST be normalized with Unicode NFKC and
must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` before it is used as the
`TOOL_CALL` span name, subject to an invocation-local limit of 128 distinct
normalized names. Invalid, oversized, or normalization-failing values, and
names beyond the cardinality limit, MUST use `OpenCode tool call`; the adapter
MUST emit at most one bounded overflow diagnostic per invocation.
It MUST NOT duplicate the raw or normalized tool name in metadata. It MUST not
persist tool input, output, or tool-part metadata.

### R6. Terminal-response fallback and deduplication

`parseOpenCodePromptResponse` MUST remain the source of the existing terminal
structured output and `SeqlaneInvocationMetrics`. Its response schema already
validates assistant message ID, session ID, provider, model, cost, timing, and
token fields.

The terminal response MUST be reconciled with reducer state before native span
creation or completion. When its `(sessionID, messageID)` matches an existing
assistant message, it updates or completes that model span and MUST NOT create
another span. When event coverage has no safe matching message identity, the
adapter MAY create one invocation-local fallback generation. The equivalent
terminal response has a maximum of one fallback.

The first valid terminal outcome is authoritative. Repeated terminal signals,
duplicate response handling, and equivalent fallback observations MUST be
idempotent. If the response is malformed, the existing executor error path
remains authoritative and no unverifiable native span is created.

OpenCode supplies observed start and end timestamps for tool parts. Mastra
1.64 child-span creation supports a backdated start time but its public end and
error APIs do not accept an end timestamp. The adapter MAY retain a bounded
observed terminal timestamp as namespaced metadata for trace diagnosis, but
MUST NOT represent it as the Mastra span end time or claim that automatic
duration metrics use it.

### R7. Usage and cost mapping

For each model-generation span, the adapter MUST map per-message values only:

| OpenCode observation | Mastra 1.64.0 field | Rule |
| --- | --- | --- |
| `providerID` | `attributes.provider` | Preserve normalized provider identity |
| `modelID` | `attributes.model` | Preserve normalized model identity |
| `tokens.input` | `attributes.usage.inputTokens` | Use the individual message value |
| `tokens.output` | `attributes.usage.outputTokens` | Use the individual message value |
| `tokens.reasoning` | `attributes.usage.outputDetails.reasoning` | Preserve when provided |
| `tokens.cache.read` | `attributes.usage.inputDetails.cacheRead` | Preserve when provided |
| `tokens.cache.write` | `attributes.usage.inputDetails.cacheWrite` | Preserve when provided |
| `cost` | `attributes.costContext.estimatedCost` | Use the executor-reported value |
| verified cost unit | `attributes.costContext.costUnit` | Omit when the unit is not established |
| cost source | `attributes.costContext.costMetadata.source` | Use `executor_reported` |

Missing values MUST remain absent. The adapter MUST NOT infer per-message
usage from aggregate totals or reprice the executor response. Cost metadata
MUST identify the executor as the source and preserve a verified currency or
unit. If the configured Mastra contract cannot establish the unit, cost
context MUST be omitted and a bounded diagnostic emitted.

### R8. Existing metrics and activity remain separate

`onMetrics` continues to receive the existing aggregate
`SeqlaneInvocationMetrics` from the validated terminal response. It is not a
native Mastra metric sink and MUST NOT be replaced with span writes.

`onActivity` and background-process callbacks continue to receive their
existing OpenCode activity projections from the shared reducer. They MUST NOT
read Mastra spans or depend on Mastra storage, sampling, or export status.

Native Mastra spans are an additional projection of the same validated event
reducer. A Mastra storage or exporter failure MUST NOT suppress activity,
aggregate metrics, structured output, or the OpenCode execution result.

### R9. Cancellation, closure, and failures

On request cancellation, the adapter MUST abort the OpenCode prompt and close
open tool and model spans as cancelled. On interaction, transport failure, or
event-stream closure, it MUST close open child spans with bounded failure
metadata and preserve the existing executor outcome.

Completed child spans MUST remain complete if a later repair, task, or
enclosing workflow step fails. On normal completion, the adapter closes leaf
tool spans, then model spans, then `AGENT_RUN`. It MUST not close the workflow
step. Repeated terminal, abort, or close signals MUST be safe.

### R10. Data minimization and isolation

All event and terminal-response fields entering Mastra MUST pass one common
redaction and size policy. Secrets, credentials, authorization headers, raw
prompts, raw transcripts, tool arguments, tool results, and unrestricted error
text MUST be omitted or bounded by default.

Session IDs, message IDs, and call IDs MAY be retained as bounded trace
correlation attributes. They MUST NOT become metric labels, entity keys, or
unbounded span names. Message content MUST never be used for correlation.

OpenCode private metadata is limited to this allowlist:

| Key | Owning span | Source | Bound | Redaction and use |
| --- | --- | --- | --- | --- |
| `seqlane.invocationId` | `AGENT_RUN` | Request `invocationId` | 128 UTF-16 code units | Opaque validated ID; omitted when over bound; never a metric label |
| `seqlane.adapter` | `AGENT_RUN` | Adapter constant | Fixed constant | `opencode`; not executor payload |

No other OpenCode metadata is permitted. In particular, raw executor,
session, message, tool name, tool arguments, tool results, prompts,
transcripts, configured model, timestamps, or unrestricted errors MUST NOT be
written as metadata. Session, message, and call IDs remain correlation data
only where the typed or explicitly documented span field requires them.

Span creation, update, and closure MUST be no-throw from the execution
perspective. Diagnostics MUST be bounded and execution MUST continue when
native observability cannot be recorded.

## Detailed design or contracts

### OpenCode execution order

For one OpenCode invocation, the required order is:

1. Runtime admits the invocation and supplies the private observability
   context to the adapter request.
2. The adapter opens one `AGENT_RUN` when a current Mastra span exists.
3. The adapter resolves the session, task schema, model selection, and
   structured-output strategy.
4. For attempt `n`, the adapter builds the prompt and creates cancellation and
   interaction controllers.
5. The adapter subscribes once to the OpenCode event stream.
6. One reducer validates each event once and updates interaction, activity,
   background-process, model, and tool state.
7. The adapter submits `session.prompt` after the subscription is ready.
8. Event fan-out updates existing `onActivity` and native spans while the
   prompt is in flight. Interaction ends the prompt through the existing
   cancellation path.
9. The terminal response parser validates the response and produces the
   existing structured result and aggregate metrics.
10. The adapter reconciles terminal identity and usage with event-reducer
    state. It creates at most one fallback model span.
11. If structured output fails validation and repair remains available, the
    adapter preserves completed child spans and repeats from step 4 within the
    same `AGENT_RUN`.
12. On final success or failure, the adapter closes open leaves, model spans,
    and the agent run, then emits the existing result or error.

The event reducer is the only owner of OpenCode event identity and lifecycle.
Prompt response parsing remains the owner of terminal response validation and
aggregate metrics. The native Mastra projection does not become a second
execution path.

### Native metric derivation

The adapter MUST use the typed Mastra span categories and fields supported by
the configured Mastra version. Mastra derives native agent, tool, model
duration, token, and cost-context metrics from the spans. The adapter MUST
not create a second manual metric contract. Sampling can omit spans and
derived metrics. Seqlane aggregate metrics remain the execution record.

### Current evidence and verification boundary

Verified by the current implementation and focused tests:

- `@opencode-ai/sdk` is pinned to 1.18.27.
- `session.ts` subscribes once before each prompt.
- One event consumer validates and reduces interaction, activity,
  background-process, model, and tool observations.
- `prompt-response.ts` validates terminal assistant message provider, model,
  cost, tokens, timing, session, and message identity.
- SDK v2 exposes the assistant-message and tool-part fields required for the
  projection.
- `@mastra/core` 1.64.0 exposes the required span types and typed fields.
- `AgentAdapterRequest.observability` reaches the adapter without entering
  public core, event, Plan, or runner contracts.
- A deterministic span sink verifies typed agent, model, and tool hierarchy,
  fields, deduplication, bounded payload policy, and descendant-first closure.
- Cancellation, malformed events, alias conflict, missing tracing, terminal
  fallback, and span-operation failures preserve the OpenCode outcome.
- Mastra automatic metrics consume the completed typed spans. The adapter does
  not emit duplicate native metric rows.

## Failure and edge cases

- **Malformed event:** Diagnose and ignore when safe. Do not create a span.
- **Unsupported event:** Diagnose and retain terminal fallback eligibility.
- **Duplicate assistant update:** Reconcile by `(sessionID, messageID)`.
- **Duplicate tool update:** Reconcile by `(messageID, callID)`.
- **Missing event coverage:** Use one deduplicated terminal fallback.
- **Missing usage or cost:** Omit the field. Do not infer or reprice.
- **Structured-output repair:** Create a separate generation for its assistant
  message inside the same agent run.
- **Interaction request:** Preserve existing interaction failure semantics and
  close open native spans through the cancellation or failure path.
- **Prompt cancellation:** Abort OpenCode and close open spans as cancelled.
- **Stream disconnect:** Close open spans as failed or disconnected and retain
  the existing executor error.
- **Mastra exporter failure:** Emit a bounded diagnostic and preserve execution.
- **No current Mastra span:** Skip native spans and preserve execution.
- **Redaction overflow:** Truncate or omit the field under the fixed bound.

## Migration

This is an additive private adapter projection. Existing OpenCode session,
prompt, interaction, terminal parsing, `onMetrics`, and `onActivity` behavior
remains authoritative. The runtime and private adapter contract gain the
required per-invocation observability context. The OpenCode adapter adds one
reducer fan-out and native span lifecycle without changing public Seqlane
contracts or runner messages.

No historical metric or transcript migration is required. Existing callers
without tracing pass an empty or no-op context. Other adapters remain governed
by separate projection specifications.

## Verification

Tests MUST cover observable contracts and boundary behavior:

- per-invocation context reaches the OpenCode adapter without leaking into
  public packages.
- one subscription and one reducer are used per prompt attempt.
- interaction, `onActivity`, background-process, and native span outputs are
  all produced from the same validated event observations.
- one model span per assistant message, including repair responses.
- repeated message updates and terminal fallback are deduplicated.
- one tool span per `(messageID, callID)` with correct model parentage.
- provider, model, token, cache, reasoning, cost, source, and unit mapping.
- malformed and unsupported event handling.
- normal completion, interaction, cancellation, disconnect, and later task
  failure closure.
- Mastra span or exporter failure does not change execution outcomes.
- redaction, bounds, correlation restrictions, and no-current-span behavior.
- existing aggregate `onMetrics` and `onActivity` behavior remains compatible.
- deterministic Mastra test storage or an equivalent sink derives expected
  native agent, tool, model duration, token, and cost-context metrics.

These tests run against the pinned adapter and Mastra type contracts. Exported
metric availability remains subject to the configured Mastra exporter,
storage, and sampling policy.

## Acceptance criteria

The specification is complete when:

- the private request carries the current invocation observability context.
- each prompt attempt has one subscription and one validated reducer.
- one reducer fan-out serves interaction handling, existing activity, and
  native span projection.
- each invocation has at most one `AGENT_RUN` and each assistant message has
  exactly one deduplicated `MODEL_GENERATION`.
- each tool part has one correctly parented `TOOL_CALL`.
- terminal fallback never duplicates event-backed generations.
- per-message usage and executor-reported cost preserve source and unit
  semantics.
- cancellation, closure, disconnect, and later failure close only spans that
  remain open and never close the workflow-step parent.
- Mastra failures do not alter OpenCode execution or existing callbacks.
- data remains redacted and bounded.
- public Seqlane contracts remain Mastra-free.
- required tests pass against the pinned OpenCode and Mastra contracts.
- configured Mastra storage derives the expected native metrics, subject to
  sampling.

## Traceability

- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](./2026-09-07-mastra-native-agent-observability.md)
- [adr.opencode-executor-integration: Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration: OpenCode Executor Integration](./2026-09-02-opencode-executor-integration.md)
- [spec.consumer-agnostic-seqlane-execution-events: Consumer-Agnostic Seqlane Execution Events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](./2026-09-02-executor-neutral-workflow-authoring.md)

### Current implementation sources

- [OpenCode SDK 1.18.27](https://www.npmjs.com/package/@opencode-ai/sdk/v/1.18.27)
- [Mastra automatic metrics](https://mastra.ai/reference/observability/metrics/automatic-metrics)
- [Mastra spans reference](https://mastra.ai/reference/observability/tracing/spans)
