---
id: spec.acp-mastra-observability-projection
title: ACP v1-to-Mastra Observability Projection
status: active
owners:
  - core
created: 2026-09-07
updated: 2026-09-08
upstream:
  - adr.mastra-native-agent-observability
  - spec.mastra-native-agent-observability
supersedes: []
---

# ACP v1-to-Mastra Observability Projection

## Summary

This specification applies only to ACP protocol version 1. ACP v2 is outside
its scope. The private Seqlane adapter uses `@mastra/acp` 0.4.0. Its current
lockfile resolution is `@agentclientprotocol/sdk` 0.21.1, which exports
`PROTOCOL_VERSION = 1`.

`AcpAgentStream` is an existing private ACP execution port declared in
`libs/seqlane-acp/src/contracts.ts`. It is not an observability port.
`createDefaultAgent()` adapts `MastraAcpAgent.stream()` from `@mastra/acp`
0.4.0 to this Seqlane-owned port. The port exposes AI SDK-style `fullStream`
chunks and a final `text` promise. It does not expose raw ACP v1 types.

This specification does not create or change `AcpAgentStream`. The
observability contract starts at `AgentAdapterRequest.observability` and ends
at the Mastra spans that the ACP adapter emits. The bridge consumes execution
observations that are already available through `AcpAgentStream`.

The current boundary does not expose ACP session IDs, ACP state updates, ACP
usage updates, agent-message IDs, or raw ACP tool status patches. It also does
not expose the provider, model, tokens, or cost for the underlying model.
Therefore, this specification projects agent and tool activity only. It does
not create model-generation spans or native model usage metrics.

## Goals

- Create one Mastra `AGENT_RUN` for each admitted `AgentAdapter.execute`
  invocation.
- Parent the run to the current Mastra workflow step when one exists.
- Project normalized stream tool chunks with one span per tool call.
- Keep structured-output repair attempts inside the same agent run.
- Parse ACP v1 stream chunks once and share one adapter-local lifecycle
  reducer between activity and native observability outputs.
- Keep native model metrics unavailable until the private adapter port exposes
  valid per-generation data.
- Isolate malformed chunks, exporter failures, and cancellation from execution
  semantics.

## Non-goals

- Treating the `@mastra/acp` stream as an ACP session event stream.
- Adding ACP or Mastra types to public Seqlane contracts, Plans, workflow
  authoring, serialized events, or runner IPC.
- Creating `MODEL_GENERATION` spans from text chunks, step-finish chunks,
  finish chunks, or synthetic zero usage.
- Inferring the underlying provider, model, tokens, or cost from configuration
  or from the `@mastra/acp` pseudo model.
- Persisting text, tool arguments, tool content, or tool results by default.
- Adding replay or raw ACP session lifecycle handling at this stream boundary.

## Terminology

- **ACP v1 execution port:** The Seqlane-owned private `AcpAgentStream`. It has
  `fullStream` and `text`. `@mastra/acp` is its current client implementation.
- **Adapter instance:** The private `AcpAgent` and its connection state. It is
  not an ACP protocol `sessionId`.
- **Prompt attempt:** One call to `agent.stream` for one prompt. A repair prompt
  is a new attempt in the same `execute` invocation.
- **Admitted invocation:** An `execute` operation whose queued callback started.
- **Invocation ID:** The private `AgentAdapterRequest.invocationId`.
- **External tool key:** The invocation-local tuple
  `(invocation ID, attempt index, toolCallId)`. The adapter instance is
  implicit in the adapter-owned map. The validated raw `toolCallId` is kept
  in Mastra's typed `toolCallId` span attribute for trace correlation. It
  never becomes a metric tag or label.
- **Normalized tool name:** A validated, deterministically sanitized tool name
  used for named-tool telemetry within a fixed cardinality budget.
- **Pseudo model:** `provider: "@mastra/acp"` and `modelId: "acp-agent"`, as
  exposed by the current package. These values identify the wrapper, not the
  underlying model.

## Requirements

### R1. ACP v1 execution and observability boundaries

The existing ACP adapter MUST own the private `AcpAgentStream` execution port.
The port contains only `fullStream: ReadableStream<unknown>` and
`text: Promise<string>`. This specification MUST NOT add Mastra types,
observability context, or span operations to that port.

`@mastra/acp` 0.4.0 is the current client implementation behind the execution
port. It does not own the Seqlane adapter contract.

The default implementation uses `@agentclientprotocol/sdk` `^0.21.0`. The
current lockfile resolves 0.21.1, which exports `PROTOCOL_VERSION = 1`. Raw ACP
v1 types MUST remain behind `@mastra/acp`.

The adapter MUST use `AgentAdapterRequest.observability` from the shared
private adapter contract. The supported Mastra contract is `@mastra/core`
1.64.0. Each package that imports `ObservabilityContext`, `SpanType`, or span
types MUST declare `@mastra/core` directly at the workspace-pinned version.
It MUST NOT rely on the transitive peer dependency from `@mastra/acp`.

### R2. Admission, run lifecycle, and parentage

The existing ACP execution scheduler serializes calls through an adapter-owned
promise tail. Its queue is currently unbounded and not abort-aware. This
specification does not redefine queue capacity or cancellation. The bridge
starts when the queued operation callback begins. Queue wait remains part of
the Mastra workflow step, not `AGENT_RUN`.

For each admitted invocation, the adapter MUST open exactly one `AGENT_RUN`
before adapter-local validation, prompt construction, schema conversion, or
the first prompt attempt. The run MUST use the current workflow-step span as
its parent. If no current span exists, instrumentation MUST be a no-op.

The run MUST close after the final validated result, adapter-local validation
failure, request cancellation, or observed stream failure. The adapter MUST
close child tool spans first. All close operations MUST be idempotent. The
adapter MUST NOT close the workflow-step span.

Structured-output repair prompts are additional attempts inside the same run.
The zero-based `attemptIndex` starts at `0` for the first prompt. Human-facing
attempt counts can remain one-based and MUST NOT be used as correlation keys.

### R3. Adapter-local observability composition

ACP v1 MUST be one concrete private adapter registration. It is bound to the
pinned ACP v1 package set and owns its Zod schemas, lifecycle reducer, and
Mastra projection.

For observability, the shared `AgentAdapter` request contract exposes only the
per-invocation Mastra context. Shared internal projector code is limited to
no-throw span helpers, redaction, and bounded diagnostics. It MUST NOT define
a generic executor-observation union.

### R4. Canonical validation and tool lifecycle

One Zod-owned ACP v1 stream schema MUST validate each known chunk once. Types
MUST be inferred from that schema. The validated chunk feeds one adapter-local
tool reducer. The reducer is the lifecycle source for both `onActivity` and
native Mastra spans. Neither output consumes the other output.

The adapter-owned map uses this key:

```text
(invocationId, attemptIndex, externalToolCallId)
```

The external ID MUST be validated to 1-256 characters. The bridge MUST use
that validated value as Mastra's typed `toolCallId` span attribute. This
preserves the executor identity for trace correlation and deduplication. The
bridge MUST NOT copy it into a metric tag, metric label, span tag, entity ID,
or span name. The automatic-metrics configuration MUST retain Mastra's
high-cardinality protections.

The external tool name MUST be validated to 1-256 characters. Before it is
used for native telemetry, the adapter MUST normalize it with Unicode NFKC.
The result MUST match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. A value that does
not match uses the constant `ACP v1 tool call`. The adapter MUST allow at most
128 distinct normalized names per invocation. Additional names use that same
constant and emit at most one bounded diagnostic. The normalized name MUST be
the span `name`. It MUST NOT also become an `entityName`, tag, metadata field,
or custom attribute. This keeps named-tool correlation in the native span name
without creating an implicit metric dimension outside the typed attribute
allowlist. Arguments, content, and results do not enter native telemetry.

The reducer MUST implement these transitions:

| Current state | Valid observation | Action |
| --- | --- | --- |
| unseen | `tool-call` or `tool-call-delta` | Open one tool record and one span |
| unseen | `tool-result` | Reject through the existing malformed-stream path |
| open | `tool-call` or `tool-call-delta` | Keep one record and update local progress only |
| open | `tool-result` | Close once. `isError === true` means failure, otherwise success |
| closed | duplicate matching `tool-result` | Ignore without another metric contribution |
| closed | any other tool observation | Diagnose and ignore. Never reopen the span |

Matching means the same external tool key, tool name, and terminal outcome.
The adapter does not retain or compare raw result content.

The native tool span name MUST use the normalized tool name or its constant
fallback. A later name change MUST NOT change tool identity or the span name.
Raw delta text, arguments, content, and results MUST NOT enter the span.

The stream exposes no tool timestamps. The bridge MUST create and end spans at
local receive time with Mastra `Date` timestamps. It MUST NOT backdate spans.
At attempt termination, the bridge MUST close each open tool as incomplete,
cancelled, or failed before it continues or closes the run.

### R5. Native Mastra span contract

The bridge MUST call `currentSpan.createChildSpan` with
`SpanType.AGENT_RUN`. Tool spans MUST use
`agentRunSpan.createChildSpan` with `SpanType.TOOL_CALL`. It MUST NOT call
`endTree` or create another workflow-step span.

The agent span MUST use the constant name `ACP v1 agent run`. It contains no
prompt, input, output, or model attributes. A tool span MUST use the normalized
tool name or its constant fallback. It MAY contain only these typed attributes:

```ts
{
  toolType: "acp-v1",
  toolCallId: boundedExternalToolCallId,
  success?: boolean,
}
```

Mastra 1.64.0 defines `toolCallId` as a typed `TOOL_CALL` attribute. Its
automatic duration metric uses a `status` label and the span's correlation
context. The adapter MUST NOT emit a manual metric label for `toolCallId` or
the tool name. The normalized span name provides named-tool correlation, and
its cardinality budget above applies.

Success or failure MUST be set only at terminal closure. Cancellation,
incomplete, and failed outcomes MUST use bounded namespaced metadata and safe
constant errors. An incomplete tool leaves `success` unset but ends through
the error path. The original execution error remains the private execution
cause and MUST NOT enter the span.

Mastra derives agent/tool duration metrics when these spans end. Those metrics
are outputs. The adapter MUST NOT submit a second manual native metric row.

### R6. No model projection and metric separation

Text-delta, text-start, text-end, `step-finish`, and `finish` chunks MUST create
no `MODEL_GENERATION` span. The synthetic zero usage in finish chunks MUST NOT
create token metrics. The pseudo model values `@mastra/acp` and `acp-agent`
MUST NOT become provider or model attributes.

The configured model is requested configuration, not observed model use. It
MUST NOT enter native Mastra span attributes or metadata. Existing
`request.onMetrics` and `request.onActivity` callbacks remain separate
Seqlane outputs. The native bridge MUST NOT subscribe to either callback.

### R7. Failure ownership

The adapter owns synchronous span-operation isolation. It MUST wrap span
create, update, error, and end calls. On the first span-operation failure, it
MUST make a best-effort no-throw close of known open spans. It then clears its
handles, disables native projection for that invocation, and continues
execution.

The adapter MUST invoke its bounded diagnostic sink through a no-throw helper.
A diagnostic failure MUST be swallowed and MUST NOT recurse. At most one
diagnostic reports that native projection was disabled.

The Mastra runtime owns storage, exporter, sampling, flushing, and dropped
event behavior. The adapter MUST NOT await, flush, retry, or shut down the
export pipeline. Backend failures MUST NOT change an ACP execution outcome.

### R8. Cancellation and observed disconnects

Request cancellation MUST stop the active stream through the existing abort
path. The bridge MUST close open tool spans and the agent run once with safe
cancellation metadata. An observed stream failure MUST close spans before the
adapter disconnects or replaces its private agent instance.

The current adapter contract has no global disposal hook. This specification
therefore defines no unobservable process-teardown requirement. A future
disposal API MUST define active-request cancellation and awaited span closure
before implementation.

### R9. Data minimization and bounds

The projection MUST use this allowlist:

| Value | Rule |
| --- | --- |
| External tool-call ID | Validate at 1-256 characters. Use as typed `toolCallId` trace correlation. Never use as a metric tag or label |
| External tool name | Validate at 1-256 characters. Normalize and bound it. Apply the per-invocation cardinality limit before named-tool telemetry |
| Invocation ID | Use the validated Seqlane ID. Omit from spans above 128 characters |
| Attempt index | Zero-based non-negative integer |
| Diagnostic | Allowlisted code and constant message of at most 256 characters |
| Tool count | At most 1,024 records per admitted invocation, across all prompt attempts |

Prompts, text, thought content, arguments, results, credentials,
authorization data, configured models, and raw errors MUST be omitted from
native spans by default because they are sensitive and unbounded. Raw IDs and
tool names follow the field-specific rules above. They are not subject to a
blanket ban. A future content-capture feature requires a separate, explicit
opt-in contract for consent, redaction, bounds, retention, and access.

A pseudo model identifies the ACP wrapper, not the underlying model. Thus,
`@mastra/acp` and `acp-agent` MUST NOT populate native provider or model
fields. The bridge MAY record `adapter: "acp-v1"` as bounded namespaced
metadata. Synthetic zero usage MUST be ignored because `@mastra/acp` 0.4.0
hardcodes it. Recording this value falsely reports an observed zero-token
model call when this boundary observed no model usage.
An external stream limit violation follows the existing bounded adapter error
path. A native-only attribute limit violation omits the attribute and emits a
bounded diagnostic. Neither path can increase a limit or persist a truncated
secret-bearing payload.

## Detailed design or contracts

### Composition topology

```text
Mastra workflow step
  -> AgentAdapterRequest.observability       shared private input
  -> ACP queued callback start               existing scheduler boundary
  -> ACP v1 parser + tool reducer             adapter-local authority
       -> onActivity                          existing Seqlane output
       -> AGENT_RUN / TOOL_CALL spans         native Mastra output
  -> onMetrics                                separate aggregate output
```

The parser validates each external chunk once. The reducer owns lifecycle and
deduplication. Output adapters receive reducer transitions and cannot feed data
back into the reducer. This one-way flow prevents loops and double counting.

### Stream mapping

| Validated stream chunk | Reducer transition | Native projection |
| --- | --- | --- |
| `text-delta` or text boundary | none | none |
| first `tool-call` or `tool-call-delta` | unseen to open | create `TOOL_CALL` |
| later `tool-call` or `tool-call-delta` | open to open | no sensitive span update |
| `tool-result`, `isError !== true` | open to closed | end with `success: true` |
| `tool-result`, `isError === true` | open to closed | error/end with `success: false` |
| `step-finish` or `finish` | none | none. Ignore synthetic usage |
| resolved `stream.text` | attempt result | Validate output. Never use it as model usage |

### Invocation sequence

```text
execute(request)
  -> wait for queued operation callback
  -> if cancelled before callback: no AGENT_RUN
  -> open AGENT_RUN after callback start
  -> do adapter-local validation and prompt construction
  -> attemptIndex 0: agent.stream(prompt)
  -> parse once, reduce tool lifecycle, and fan out outputs
  -> validate final text
  -> if repair is allowed: close open attempt tools, keep AGENT_RUN open
  -> attemptIndex 1..N: agent.stream(repair prompt)
  -> close open tools
  -> close AGENT_RUN after final result or observed failure
```

The adapter does not reuse a run across two admitted invocations. Reusing the
private ACP process or connection does not change run identity.

## Failure and edge cases

- **No current span:** Continue ACP execution without native spans.
- **Cancellation before the queued callback starts:** Create no agent span. The
  workflow step owns the queue wait and cancellation.
- **Adapter-local validation failure after callback start:** Close the agent span
  with a safe error.
- **Stream or text failure:** Close open tools, then close the agent span.
- **Repair:** Increment the zero-based index and keep the agent span open.
- **Result before tool open:** Use the existing malformed-stream error path.
- **Duplicate matching result:** Ignore it after the first terminal result.
- **Conflicting or late observation:** Diagnose and ignore it for native spans.
- **Open tool at attempt end:** Close it as incomplete, cancelled, or failed.
- **Span API failure:** Disable native projection for the invocation.
- **Diagnostic failure:** Swallow it and do not call the sink again.
- **Exporter/storage failure:** The runtime isolates it from execution.
- **Unknown chunk:** Ignore it when the existing stream contract permits.
- **Sensitive or oversized value:** Omit it or use the bounded adapter error
  path. Never persist partial secret-bearing data.

Attempt termination uses this mapping:

| Cause | Open tool outcome | Mastra closure |
| --- | --- | --- |
| Normal stream end or repair boundary | `incomplete` | `error` with a safe incomplete error. Leave `success` unset |
| Request cancellation | `cancelled` | `error` with `success: false` and a safe cancellation error |
| Stream, malformed-chunk, text, or interaction failure | `failed` | `error` with `success: false` and a safe constant error |
| Native projection disabled | `projection-disabled` | Best-effort no-throw `end`, then clear the handle |

The adapter closes tools before it closes the agent run. The first terminal
transition is authoritative. Later transitions cannot change the outcome.

Replay and raw session lifecycle rules do not apply to this execution port.

## Migration

This specification adds native observability to the existing ACP v1 adapter.
The implementation adds the required observability context and the ACP v1
parser/reducer fan-out without changing public Seqlane contracts.

Packages that import Mastra observability types or values add a direct
workspace-pinned `@mastra/core` dependency. The implementation preserves the
existing aggregate `onMetrics` and activity `onActivity` outputs. It does not
use either callback as an input to native observability.

Native ACP v1 support initially emits only `AGENT_RUN` and `TOOL_CALL` spans.
It emits no model spans or model metrics.

## Verification

Tests MUST prove:

- the Seqlane-owned stream seam isolates `@mastra/acp` and ACP v1 types.
- the implementation uses ACP protocol version 1.
- queue wait is outside the agent span and cancellation before callback start
  creates no agent span.
- adapter-local failures after callback start close exactly one agent span.
- repair attempts use zero-based indexes inside one agent span.
- one Zod-derived parser and reducer feed both output paths.
- reducer transitions cover result-before-open, repeated open/progress,
  duplicate terminal, conflicting terminal, late update, and tool ID reuse.
- bounded raw external tool IDs enter only Mastra's typed `toolCallId` span
  attribute and never become metric tags or labels.
- normalized tool names produce useful named-tool telemetry within the stated
  cardinality limit.
- span construction uses `SpanType.AGENT_RUN` and `SpanType.TOOL_CALL` from
  `@mastra/core` 1.64.0 with the specified parentage and allowlist.
- tool timestamps use local `Date` values and are not backdated.
- text chunks, synthetic zero usage, pseudo model identity, requested model,
  `onMetrics`, and `onActivity` create no model metrics.
- span-operation and diagnostic failures disable projection without changing
  execution.
- runtime exporter/storage failures do not change ACP outcomes.
- redaction, field limits, cardinality limits, and constant safe errors hold.
- no public core, event, Plan, workflow, or runner contract gains ACP or
  Mastra types.

Use the private controlled-agent seam and a deterministic Mastra span sink.
Assert typed span fields, parent IDs, lifecycle transitions, and derived metric
inputs. Do not assert implementation class names or raw payload content.

## Acceptance criteria

The specification is satisfied when:

- the implementation clearly targets ACP protocol version 1 through
  `@mastra/acp` 0.4.0 and resolved `@agentclientprotocol/sdk` 0.21.1.
- one admitted invocation creates one agent span for all repair attempts.
- one canonical reducer produces at most one tool span and metric contribution
  for each external tool lifecycle.
- bounded raw IDs are trace-only and never metric dimensions.
- normalized tool names are allowed for named-tool telemetry.
- prompts, arguments, results, and other content remain omitted by default.
- pseudo identity never populates native provider or model fields.
- synthetic zero usage is ignored.
- shared runtime context, adapter-local protocol logic, and Mastra output each
  have one owner and a one-way dependency.
- span and diagnostic failures cannot change execution.
- aggregate callbacks and native spans remain separate outputs.

## Traceability

- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](./2026-09-07-mastra-native-agent-observability.md)
- [adr.executor-neutral-workflow-authoring: Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)

### Current implementation sources

- [`@mastra/acp` 0.4.0 on npm](https://www.npmjs.com/package/@mastra/acp/v/0.4.0)
- [`@agentclientprotocol/sdk` 0.21.1 on npm](https://www.npmjs.com/package/@agentclientprotocol/sdk/v/0.21.1)
- [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
- [Mastra ACP agent reference](https://mastra.ai/reference/acp/acp-agent)
- [Mastra metrics overview](https://mastra.ai/docs/observability/metrics/overview)
- [Mastra automatic metrics](https://mastra.ai/reference/observability/metrics/automatic-metrics)
- [Mastra spans reference](https://mastra.ai/reference/observability/tracing/spans)
- [Mastra tracing overview](https://mastra.ai/docs/observability/tracing/overview)
