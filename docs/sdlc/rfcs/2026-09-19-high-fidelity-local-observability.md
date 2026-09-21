---
id: rfc.high-fidelity-local-observability
title: High-Fidelity Local Model and Agent Observability
status: proposed
owners:
  - core
created: 2026-09-19
updated: 2026-09-19
upstream:
  - prd.seqlane-on-mastra
  - rfc.execution-observability-and-debugging
supersedes: []
---

# High-Fidelity Local Model and Agent Observability

## Summary

Seqlane needs complete execution data during local runs. Model requests and
responses, task values, tool calls, and skill calls must enter one
protocol-owned canonical observation stream. Mastra and CLI/TUI consume that
stream as projections.

This RFC proposes a local high-fidelity capture mode. It keeps raw values in
the local execution path. It does not redact or truncate values because of a
policy. It does not change the executor-neutral public authoring boundary.

The current RFC for execution observability remains the broad foundation. This
RFC proposes a focused change to its data-capture policy and to the
OpenCode-observation-to-protocol pipeline. Mastra is a downstream projection,
not a second source of truth.

## Context

The runtime already emits task input, task result, and executor activity
events. These events do not provide a complete model exchange. The OpenCode
assistant observation keeps identity, timing, usage, model, provider, and cost
fields, but drops message content before the observation reaches Mastra.

The native Mastra projection also records model usage and tool state without
the request, response, or tool payload. Some protocol values pass through a
selection and size policy, so users cannot always inspect the data that drove
the workflow.

Users need this information to improve workflows, compare model attempts,
measure input and output, and understand tool and skill use.

The current runtime is local. This RFC does not authorize raw data export to
remote services, shared telemetry, production storage, or recording files.

The canonical contract is defined in
[spec.otel-aligned-observation-contract](../specs/2026-09-19-otel-aligned-observation-contract.md).
It uses OpenTelemetry GenAI Semantic Conventions as vocabulary and guidance;
it does not add an OpenTelemetry SDK dependency.

## Goals

- Capture the complete model request and response available from each
  concrete adapter.
- Capture every structured-output repair attempt as a separate model exchange.
- Capture exact tool and skill input, output, and metadata available from the
  adapter.
- Forward one validated canonical observation into the protocol event stream;
  project that event to Mastra and CLI/TUI.
- Preserve model, provider, usage, cost, timing, identity, and lifecycle data.
- Make missing source data visible instead of silently dropping it.
- Keep all protocol and adapter contracts engine-neutral.
- Preserve exact JSON values across protocol serialization and deserialization.

## Non-goals

- Adding Mastra or provider types to `@seqlane/core` or
  `@seqlane/protocol`.
- Defining model, tool, skill, or permission controls for workflow authors.
- Persisting events for recording or replay.
- Creating a server-side run database or remote persistence service.
- Sending raw data to a remote exporter or production telemetry system.
- Changing model selection, session, cancellation, retry, or structured-output
  behavior.
- Replacing metrics with raw payloads as metric labels.

## Users and use cases

### Workflow author inspects one model exchange

The author can inspect the exact request sent to the model, the response that
returned, the selected model, token usage, cost, and the final task result.

### Workflow author compares attempts

The author can compare the initial model response with structured-output repair
responses and see which response produced the validated result.

### Workflow author inspects tools and skills

The author can see each tool and skill call, including its input, output,
metadata, timing, status, and relation to the model exchange that created it.

### Workflow author diagnoses a failed run

The author can inspect the last available model, tool, or skill payload and
the lifecycle state that preceded the failure or cancellation.

## Proposal

### R1. Local high-fidelity capture

Local runs use high-fidelity capture by default. The capture applies to every
model, tool, and skill observation in the run.

The capture path MUST NOT redact, select, or truncate a value because of a
Seqlane policy. It MUST preserve all JSON and text data that the adapter makes
available.

The protocol remains JSON-based. Values that cannot be represented as JSON
MUST be converted by the owning adapter or reported as unavailable with a
diagnostic. The runtime MUST NOT silently replace them with a summary.

Transport framing MAY split a large value into chunks. Reassembly MUST restore
the original value. Chunking is a transport detail and MUST NOT reduce the
semantic capture contract.

### R2. Model exchange event

The protocol MUST add an engine-neutral model exchange event. The event MUST
identify the Work, Run, Invocation, model exchange, and attempt when those
identities exist.

The event MUST support these fields:

- lifecycle state: started, updated, succeeded, failed, or cancelled;
- model and provider identity;
- the complete model request, including system, developer, and user messages,
  model-visible context, request options, tool definitions, and schemas;
- the complete model response, including text, structured data, tool calls,
  parts, and all reasoning traces exposed by the model or adapter;
- model response identity when supplied by the adapter;
- token, cache, reasoning, cost, and duration data;
- a serialized error for a failed exchange.

The event MUST distinguish a model exchange from the task input and the final
task result. It MUST preserve one event identity for repeated lifecycle updates
and one model exchange for each actual model response.

### R3. Tool and skill payloads

The protocol MUST preserve the complete input, output, and metadata for every
tool and skill activity that the adapter reports.

The existing activity lifecycle remains authoritative for status, timing, and
correlation. A raw payload field becomes authoritative for the full value. Any
existing summary or display projection is a derived convenience and MUST NOT
replace the raw payload.

Skill activity MUST remain distinguishable from ordinary tool activity when the
adapter can identify it from the native source. Skill identity, input, output,
loaded instructions, and metadata MUST remain associated with the same
activity identity when the source exposes them. The adapter MUST NOT invent
skill instructions or metadata that OpenCode did not expose.

### R4. Adapter observation boundary

The concrete adapter MUST emit model exchanges and activity payloads into a
protocol-owned, engine-neutral observation sink. This sink is separate from
the existing `@seqlane/core` execution-event union and existing bounded
activity callback. The runtime forwards the canonical observation to the
protocol event bridge.

Concrete adapters own extraction and validation of their native data. The
generic contract MUST contain no Mastra, OpenCode, ACP, provider SDK, or
provider-specific type.

The first implementation slice MUST cover the OpenCode adapter. ACP, Codex,
and later adapters MUST provide the same capture semantics for data that their
native protocols expose.

### R5. Protocol-first observation pipeline

The adapter MUST validate each native observation once and emit one canonical
protocol observation. The pipeline is:

1. native OpenCode observation;
2. protocol-owned canonical observation and `invocation.observation` event;
3. serialized protocol event stream; and
4. Mastra and CLI/TUI projections, plus existing derived activity, metrics,
   diagnostics, interaction, and lifecycle callbacks.

The runtime MUST NOT reconstruct model or activity payloads from aggregate
metrics, terminal summaries, rendered terminal output, or Mastra spans. The
protocol observation/event is the single source of truth for downstream
consumers.

The protocol event and Mastra projection MUST retain stable Work, Run,
Invocation, attempt, model exchange, message, and activity correlation.

### R6. Mastra payload projection

The private runtime projection MUST consume the validated protocol observation
event and project full model request and response data into the Mastra
model-generation observation supported by the pinned Mastra version. It MUST
prefer the pinned Mastra span `input`/`output` fields or a supported event span
mechanism. If no current Mastra span exists, it MUST diagnose and skip the
Mastra projection while protocol delivery continues.

Tool and skill spans MUST carry their available payloads through the equivalent
supported Mastra mechanism. Raw payloads MUST remain data fields, not generic
attributes, metric labels, sampling keys, or span names.

The Mastra projection MUST be attempted for every local protocol observation.
A missing exporter or span write failure MUST be diagnosed and MUST NOT
suppress protocol events or change execution.

The Mastra projection MUST include all model, tool, and skill data exposed by
the adapter, including reasoning traces when the adapter provides them.

### R7. Data availability and failures

Every source value that the adapter receives MUST be forwarded into the
canonical protocol observation or diagnosed. Complete means every value
exposed by the adapter/native OpenCode source; it does not include hidden
OpenCode server context that the adapter cannot observe.
The adapter MUST report when a native protocol does not provide a requested
value, when a value cannot be represented in JSON, or when a projection fails.

A missing response payload MUST NOT prevent the lifecycle, identity, usage, and
error fields from reaching the protocol or Mastra.

Observation failures MUST remain separate from execution failures unless the
existing execution contract already treats the source failure as fatal.

### R8. Cardinality and transport behavior

Raw payloads MUST NOT be used as metric labels, sampling keys, span names, or
unbounded correlation identifiers.

The local protocol MUST preserve payload ordering and event ordering. It MUST
support payloads larger than the current display limits without silently
changing their values.

The implementation MUST measure and report payload size, serialization time,
and transport failures so that local performance cost is visible.

## Architecture and boundaries

```text
Native adapter observation
          |
          v
Protocol-owned canonical observation
          |
          protocol event bridge
           |
           v
Serialized protocol event
     +-----------+-----------+
     |                       |
     v                       v
Mastra projection      CLI/TUI projection
```

The private adapter remains the owner of native model, tool, and skill
translation. The protocol package owns the canonical observation schema,
event envelope, validation, and serialization. The runtime owns Work, Run,
Invocation, and protocol event sequencing. Mastra and CLI/TUI are downstream
projections. The protocol remains independent of Mastra and native executor
types.

The model exchange contract is semantic. It MUST use names such as request,
response, model, provider, tool, skill, and activity. It MUST NOT expose
OpenCode event names, ACP chunks, Mastra span classes, or provider SDK shapes.

## Standards alignment

The underlying standard is the OpenTelemetry GenAI Semantic Conventions. The
implementation is pinned to the official repository commit
[`c88d504ab3d9879f8e50d3cc87e69775e11db234`](https://github.com/open-telemetry/semantic-conventions-genai/tree/c88d504ab3d9879f8e50d3cc87e69775e11db234),
verified on 2026-09-19. The selected source defines the `gen_ai.*` vocabulary,
including provider, request/response model, message content, tool, and usage
fields. OTel is vocabulary and semantic guidance here, not Seqlane's wire
format and not an SDK dependency.

Seqlane adds its protocol envelope and `invocation.observation` event, plus
`seqlane.*` fields for Work/Run/Invocation identity, observation identity and
lifecycle, attempt/exchange correlation, availability diagnostics, source
ordering, and skill semantics. The exact field mapping is defined by the
protocol specification and locked by contract tests at the pinned commit.

LangSmith and Datadog are consumers or mappings of standard telemetry, not
owners of the Seqlane contract. Their schemas stay out of the canonical
protocol. Future exporters may project the canonical observation into their
supported OTel or native forms.

References:

- [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [LangSmith OpenTelemetry tracing](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [Datadog OpenTelemetry LLM Observability](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation.md)

## Alternatives considered

### Keep the current redaction and size policy

Rejected for local debugging. It prevents users from seeing the data needed to
improve workflows and measure model behavior.

### Add raw data only to Mastra

Rejected. Mastra is implementation-only. Protocol consumers, local tools, and
future inspectors also need the same semantic data.

### Add raw data only to protocol output

Rejected. Mastra traces would remain incomplete and model, tool, and skill
behavior would not be correlated in native observability.

### Put model data into `invocation.output`

Rejected. Task output and model response have different meanings and
lifecycles. A dedicated model exchange event prevents consumer ambiguity.

### Capture rendered terminal output

Rejected. Terminal output loses structured fields, ordering, identity, and
adapter-specific payloads.

## Risks and trade-offs

- Local memory, IPC, and trace volume will increase with payload size.
- Raw payloads create a deliberate local data exposure risk. This RFC accepts
  that risk within the local-only scope.
- Payloads can exceed the limits of some Mastra exporters. The adapter must
  preserve the protocol event and report the exporter limitation.
- The protocol gains a larger stable contract. The model exchange schema must
  remain engine-neutral and versioned.
- Different adapters expose different data. The protocol must distinguish
  unavailable data from data that was captured as an empty value.

## Migration or rollout

1. Accept this RFC as the local observability policy.
2. Approve the active protocol observation specification with the model exchange
   and raw payload contracts.
3. Implement one OpenCode tracer through native observation, protocol event,
   serialized protocol stream, and downstream Mastra/TUI projections.
4. Add protocol round-trip, malformed-input, payload-preservation, ordering,
   and Mastra span tests.
5. Extend the same adapter contract to ACP and Codex after the OpenCode path
   is verified.
6. Measure local payload cost and add transport chunking only when evidence
   requires it.
7. Define a separate policy before any remote export or new recording/persistence
   feature is supported.

## Acceptance criteria

- A local model run emits a model exchange event with the exact available
  request and response values.
- Every structured-output repair response has a separate model exchange.
- Every reported tool and skill activity preserves exact input, output, and
  metadata in the protocol event.
- Protocol encode/decode preserves captured JSON values exactly.
- Mastra model, tool, and skill observations project the same payloads and
  correlation identities from the protocol event when the pinned API supports
  them; Mastra is never the source of truth.
- Missing or unrepresentable values produce bounded diagnostics and do not
  cause silent loss.
- Raw payloads never become metric labels, span names, or sampling keys.
- No Mastra, OpenCode, ACP, or provider SDK type appears in public protocol or
  core declarations.
- Exporter failure does not change the model result or protocol event stream.

## Open questions

- Which Mastra 1.64.0 payload fields or span events provide the most stable
  local storage path for full request and response data?
- Does the local runner need payload chunking in the first implementation, or
  does measured local traffic fit within the current IPC framing?
- Should a future recording or replay mode use a separate capture policy and
  event version, or negotiate policy on the run request?

## Traceability

- [prd.seqlane-on-mastra: Seqlane on Mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](./2026-09-02-execution-observability-and-debugging.md)
- [spec.opencode-mastra-observability-projection: OpenCode-to-Mastra Observability Projection](../specs/2026-09-08-opencode-mastra-observability-projection.md)
- [spec.mastra-native-agent-observability: Mastra Native Agent Observability](../specs/2026-09-07-mastra-native-agent-observability.md)
- [spec.otel-aligned-observation-contract: OTel-Aligned Seqlane Observation Contract](../specs/2026-09-19-otel-aligned-observation-contract.md)
- [task.implement-otel-aligned-opencode-observations: Implement OTel-Aligned OpenCode Observations](../tasks/2026-09-19-implement-otel-aligned-opencode-observations.md)
- [adr.engine-opaque-agent-adapter-contracts: Engine-Opaque Agent Adapter Contracts](../adrs/2026-09-18-engine-opaque-agent-adapter-contracts.md)
