---
id: spec.otel-aligned-observation-contract
title: OTel-Aligned Seqlane Observation Contract
status: draft
owners:
  - core
created: 2026-09-19
updated: 2026-09-19
upstream:
  - rfc.high-fidelity-local-observability
  - spec.agent-adapter-boundary-and-capabilities
  - spec.work-run-invocation-identity-model
  - spec.opencode-mastra-observability-projection
  - spec.mastra-native-agent-observability
supersedes: []
---

# OTel-Aligned Seqlane Observation Contract

## Summary

This specification defines the one canonical observation contract emitted by
concrete adapters into the Seqlane protocol event stream. The protocol owns
the source-of-truth observation and serialized event. Mastra and CLI/TUI are
downstream projections of that event.

The contract uses OpenTelemetry GenAI Semantic Conventions as vocabulary and
mapping guidance. It remains a Seqlane protocol contract. It does not import
the OpenTelemetry SDK, Mastra types, OpenCode types, ACP types, or provider SDK
types.

The first implementation targets OpenCode. The same contract can later be
implemented by ACP, Codex, and other adapters.

## Goals

- Preserve every JSON or text value exposed by the adapter for each model,
  tool, and skill observation.
- Preserve model requests, responses, context, schemas, reasoning, tool
  definitions, tool calls, skill instructions, usage, cache, cost, timing,
  errors, and lifecycle updates when the source provides them.
- Emit one engine-neutral observation from the adapter into the protocol-owned
  canonical event stream; Mastra and CLI/TUI consume that event as projections.
- Keep Work, Run, Invocation, attempt, exchange, and activity correlation
  stable across projections.
- Align standard fields with OTel GenAI names without forcing an OTel SDK
  dependency into the protocol.
- Preserve exact JSON values through protocol validation and round-trip
  serialization.

## Non-goals

- Recording, replay, event files, or a new durable event store.
- A remote exporter, production telemetry policy, or a security/redaction
  policy for future remote persistence.
- Changing model selection, retries, structured-output behavior, cancellation,
  or executor-neutral workflow authoring.
- Making raw payloads metric labels, span names, sampling keys, or correlation
  identifiers.
- A second normalized DTO package.
- Supporting every adapter in the first implementation.

## Terminology

- **Observation:** One validated semantic record for a model exchange, tool
  activity, or skill activity.
- **Model exchange:** One actual model request/response pair. A structured
  output repair is a new exchange in the same invocation.
- **Activity:** One tool or skill lifecycle. A skill remains distinguishable
  from a tool.
- **Projection:** A consumer-specific view of the protocol-owned canonical
  observation/event. Mastra spans/events and the TUI view are projections; the
  protocol event is the source of truth, not a projection.
- **Unavailable:** The source did not provide a value, or the value cannot be
  represented in the JSON protocol. An unavailable value is not the same as an
  empty value.

## Requirements

### requirement-protocol-owns-the-contract

The protocol package owns the canonical observation schema, inferred types,
event envelope, validation, and JSON serialization rules.

The concrete adapter emits into a protocol-owned observation sink typed with
the canonical observation contract. The runtime forwards that observation to
the protocol event bridge, which validates and serializes
`invocation.observation`. This path is separate from the existing
`@seqlane/core` execution-event union and bounded activity callback. The
runtime does not reconstruct observations from metrics, summaries, terminal
text, or Mastra spans.

The protocol contract MUST contain no OpenCode, ACP, Mastra, provider, or
runtime-engine types.

### requirement-otel-vocabulary

The implementation MUST target the exact OpenTelemetry GenAI Semantic
Conventions source revision selected before coding. The initial revision is
the official repository commit
`c88d504ab3d9879f8e50d3cc87e69775e11db234`, verified on 2026-09-19. Contract
tests MUST record and verify this commit. A later revision requires an
explicit contract update; there is no floating version baseline.

The contract maps standard concepts where a standard field exists and uses
`seqlane.*` extensions for Seqlane identity, lifecycle, availability, and
adapter-independent activity data. The protocol MUST NOT flatten all payloads
into an OTel attribute map. Nested request and response data remains nested so
that values and ordering are preserved.

No `@opentelemetry/*` package is required by `@seqlane/core`,
`@seqlane/protocol`, or the generic adapter contract. OTel SDK export remains a
future projection concern.

### requirement-event-envelope

The protocol adds one event type: `invocation.observation`.

Each event contains the existing protocol event metadata and:

- `workId`, `runId`, and `invocationId`;
- stable `observationId`;
- optional `parentObservationId`;
- `kind`: `model`, `tool`, or `skill`;
- `state`: `started`, `updated`, `succeeded`, `failed`, or `cancelled`;
- zero-based `attemptIndex` when the source has an attempt concept;
- the kind-specific observation payload;
- availability diagnostics for source values that are missing or
  unrepresentable.

An update MUST reuse the same `observationId`. One actual model exchange MUST
not produce multiple exchange identities because it has multiple lifecycle
updates.

### requirement-model-exchange

A model observation MUST support these semantic groups:

| Group | Required content when available |
| --- | --- |
| Identity | provider/system, model, response ID, operation name, finish reason |
| Request | system/developer/user messages, model-visible context, request options, tool definitions, response schema, input attachments or parts |
| Response | text, structured output, assistant messages, response parts, tool calls, reasoning exposed by the source |
| Usage | input, output, reasoning, cache read, cache write, and provider-specific usage fields |
| Cost and time | cost with source/unit, request/start/end timestamps, duration, and source timing |
| Failure | structured error, status, and the last available request/response data |

The event MUST distinguish the model exchange from task input and final task
result. It MUST preserve empty arrays, empty strings, `false`, `0`, and `null`
when those values are supplied by the source.

### requirement-activity-payloads

A tool or skill observation MUST preserve, when available:

- activity identity, name, parent model exchange, and lifecycle;
- exact input, output, metadata, timing, and structured error;
- for skills: skill identity, loaded instructions, skill input, skill output,
  and skill metadata when the native source exposes them;
- for tools: tool definition, call arguments, call result, and tool metadata.

The activity `kind` MUST remain `tool` or `skill` when the adapter can identify
the kind from the native source. A display summary is a projection and MUST
NOT replace the canonical payload. The adapter MUST NOT invent skill
instructions, output, or metadata that the source did not expose.

### requirement-correlation-and-order

The runtime owns Work, Run, and Invocation identity. The adapter owns native
identity translation. The canonical observation MUST retain:

- the Seqlane identity envelope;
- adapter-native model response identity when available;
- model exchange identity and attempt index;
- activity identity and parent exchange identity;
- event sequence and source timing when available.

Protocol event order MUST match adapter emission order. Consumers MUST be able
to distinguish an empty value, an unavailable value, and an observation that
has not yet received its terminal update.

### requirement-fidelity-and-availability

The local live capture path MUST NOT redact, select, summarize, or truncate a
value because of a Seqlane policy. It MUST forward all source values that can
be represented as JSON or text.

If a native value is unavailable, the adapter MUST emit an availability record
with a field path and reason such as `source-unavailable` or
`not-json-representable`. It MUST NOT silently omit the fact that the value
was unavailable. The diagnostic MUST not replace other fields from the same
observation.

Transport chunking MAY be added after measurement. If added, reassembly MUST
restore the original value and chunking MUST remain invisible to projections.

### requirement-one-fan-out

The adapter MUST validate each native source observation once and emit one
canonical observation into the protocol-owned sink. The protocol MUST own the
event envelope, sequencing, and serialization. Downstream consumers MUST read
the canonical protocol event. The pipeline is:

1. the protocol-owned canonical observation and event stream;
2. the serialized protocol event;
3. the Mastra and CLI/TUI projections; and
4. existing activity, metrics, diagnostics, and lifecycle callbacks derived
   from the canonical event.

No consumer may parse rendered terminal output or another projection to recover
payloads. A projection failure MUST NOT suppress the protocol event or change
execution outcome.

### requirement-projections

The projections have these responsibilities:

- **Protocol:** own, validate, sequence, and serialize the canonical
  observation. It is the source of truth, not a consumer projection.
- **Mastra:** consume the validated protocol observation and map standard
  fields to the pinned Mastra model, tool, and skill span/event mechanisms.
  Prefer supported span `input`/`output` or event fields. If no current span
  exists, diagnose and skip this projection. Raw payloads are data fields, not
  generic attributes, metric labels, span names, or sampling keys.
- **CLI/TUI:** render a readable summary by default and expose the complete
  captured payload through the existing detail path. Rendering MUST NOT mutate
  or truncate the protocol observation.

Mastra remains behind private runtime and concrete adapter boundaries. TUI
imports protocol contracts, not Mastra or native adapter types.

### requirement-zod-and-round-trip

The protocol MUST use one Zod schema as the source of truth for the canonical
observation and event. Types MUST be inferred from that schema.

The schema MUST accept only JSON values and text in payload fields. The
protocol MUST preserve object keys, array order, nulls, numbers, booleans,
empty values, and text exactly through encode/decode. Malformed events MUST be
rejected at the protocol boundary with a typed validation failure.

### requirement-no-recording

This change MUST NOT add a recorder, replay format, event file, local run
archive, or new persistence API. The live protocol stream and existing
configured Mastra observation storage remain separate from a future recording
feature. Recording/replay requires a later contract and explicit scope.

### requirement-boundaries

The implementation MUST keep runtime-engine and Mastra types out of
`@seqlane/core`, protocol declarations, Plans, workflow authoring, and stable
CLI result types. The protocol may define Seqlane-specific `seqlane.*` fields,
but it MUST NOT expose native adapter shapes.

## OTel-to-Seqlane mapping

The following table is the initial mapping. The exact OTel revision selected by
the implementation fixes spelling and availability for the standard fields.

| Canonical field | OTel vocabulary | Seqlane rule |
| --- | --- | --- |
| `model.operation` | `gen_ai.operation.name` | Preserve source operation; use `chat` or the source value when available. |
| `model.provider` | `gen_ai.provider.name` | Preserve provider identity. |
| `model.request.model` | `gen_ai.request.model` | Preserve the requested model name. |
| `model.response.model` | `gen_ai.response.model` | Preserve the model that produced the response when available. |
| `model.response.id` | `gen_ai.response.id` | Preserve the response identity when supplied. |
| `model.response.finishReasons` | `gen_ai.response.finish_reasons` | Preserve all reasons and ordering. |
| `model.request.systemInstructions` | `gen_ai.system_instructions` | Preserve structured instructions when exposed. |
| `model.request.inputMessages` | `gen_ai.input.messages` | Preserve messages in source order. |
| `model.response.outputMessages` | `gen_ai.output.messages` | Preserve output messages in source order. |
| `model.request.toolDefinitions` | `gen_ai.tool.definitions` | Preserve tool definitions when exposed. |
| `model.usage.inputTokens` | `gen_ai.usage.input_tokens` | Preserve the numeric source value. |
| `model.usage.outputTokens` | `gen_ai.usage.output_tokens` | Preserve the numeric source value. |
| `model.usage.reasoningTokens` | `gen_ai.usage.reasoning.output_tokens` | Preserve reasoning tokens and include them in output totals when the source semantics require it. |
| `model.usage.cacheReadTokens` | `gen_ai.usage.cache_read.input_tokens` | Preserve when the selected revision defines it. |
| `model.usage.cacheWriteTokens` | `gen_ai.usage.cache_write.input_tokens` | Preserve when the selected revision defines it. |
| request parameter fields | `gen_ai.request.*` | Preserve supported standard parameters without dropping unknown source fields. |
| `activity.name` | `gen_ai.tool.name` | Preserve the tool name when the activity is a tool call. |
| `activity.callId` | `gen_ai.tool.call.id` | Preserve the call identity when available. |
| `activity.arguments` | `gen_ai.tool.call.arguments` | Preserve structured arguments when available. |
| `activity.result` | `gen_ai.tool.call.result` | Preserve structured results when available. |
| `activity.type` | `gen_ai.tool.type` | Preserve the native tool type when available. |
| Work/Run/Invocation identity | no standard equivalent | Use `seqlane.work.id`, `seqlane.run.id`, and `seqlane.invocation.id`. |
| observation identity | no standard equivalent | Use `seqlane.observation.id`, `seqlane.parent_observation.id`, and `seqlane.attempt.index`. |
| activity kind and skill data | no complete standard equivalent | Use `seqlane.activity.kind`, `seqlane.activity.id`, and nested skill data. |
| availability | no standard equivalent | Use `seqlane.availability` with field path and reason. |

The implementation MUST add contract tests for every mapped field and for
fields that have no OTel equivalent. It MUST record the pinned OTel repository
commit in those tests. It MUST not add LangSmith or Datadog
schemas to the canonical contract. Those systems may consume OTel-aligned
projections later.

## Failure and edge cases

- **Malformed native observation:** reject it at the adapter-owned native
  schema, diagnose it, and do not emit unverifiable payload data.
- **Malformed canonical event:** reject it at the protocol boundary.
- **Missing field:** emit availability information when the source makes the
  absence observable; preserve all other fields.
- **Non-JSON value:** report `not-json-representable`; do not substitute a
  summary or silently drop it.
- **Duplicate update:** reconcile by stable observation identity and preserve
  one lifecycle record per update sequence.
- **Out-of-order source update:** preserve source event order and diagnose an
  invalid lifecycle transition without changing unrelated observations.
- **Mastra projection failure:** diagnose and continue protocol delivery and
  execution.
- **Cancellation or failure:** close open observations with the observed
  terminal state and preserve already completed observations.
- **Large payload:** retain it in the live protocol path; measure size and
  serialization cost. Add chunking only when evidence requires it.

## Implementation boundaries

Expected first-touch areas are:

- `libs/protocol`: canonical observation schema, event, validation, and
  serialization;
- `libs/adapter`: separate protocol observation sink wiring, without changing
  the `@seqlane/core` execution-event union;
- `libs/opencode`: native OpenCode extraction and canonical observation
  emission;
- `libs/runtime`: protocol event bridge and private Mastra projection wiring;
- `libs/tui`: observation view-model and detail rendering.

No new package is planned for the normalized shape. No OTel SDK dependency is
planned for the protocol or generic adapter.

## Verification

Run the test-mapping check before focused tests. Verification MUST include:

- protocol Zod validation, malformed-input, JSON round-trip, ordering, and
  payload-preservation tests;
- one OpenCode model exchange through adapter, protocol event serialization,
  Mastra projection, and TUI detail projection;
- tool lifecycle and skill payload tests with stable correlation;
- multiple model exchanges and structured-output repair attempts;
- streaming, failure, cancellation, unavailable-value, and non-JSON tests;
- exporter/projection failure isolation from protocol and execution outcome;
- public-boundary tests proving no Mastra/native types leak into protocol or
  core;
- payload size and serialization measurements before any chunking decision;
- `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

## Acceptance criteria

- One OpenCode adapter observation becomes one canonical protocol event and
  reaches Mastra and TUI as projections without losing any available JSON/text
  field.
- Every actual model exchange, tool activity, and skill activity has a stable
  identity and lifecycle.
- Structured-output repair attempts are separate model exchanges.
- Protocol encode/decode preserves captured values exactly.
- OTel GenAI mappings are covered by tests and the selected revision is
  recorded.
- `seqlane.*` fields cover correlation, availability, lifecycle, and skill
  semantics not supplied by OTel.
- The protocol observation/event is the single source of truth; Mastra and TUI
  are projections and neither becomes a second source of truth.
- Projection failure does not change execution or suppress protocol events.
- No recording/replay/event-file implementation is added.
- No OTel SDK, Mastra type, native executor type, LangSmith schema, or Datadog
  schema leaks into the public protocol contract.

## Delivery state

Draft implementation contract. No implementation or target-branch delivery is
claimed. Human approval is required before the planned task starts.

## Traceability

- [rfc.high-fidelity-local-observability: High-Fidelity Local Model and Agent Observability](../rfcs/2026-09-19-high-fidelity-local-observability.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [spec.agent-adapter-boundary-and-capabilities: Agent Adapter Boundary and Capability Model](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.work-run-invocation-identity-model: Work, Run, and Invocation Identity Model](./2026-09-02-work-run-invocation-identity-model.md)
- [spec.opencode-mastra-observability-projection: OpenCode-to-Mastra Observability Projection](./2026-09-08-opencode-mastra-observability-projection.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](./2026-09-07-mastra-native-agent-observability.md)
- [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)
