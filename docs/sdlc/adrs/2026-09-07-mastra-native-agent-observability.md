---
id: adr.mastra-native-agent-observability
title: Project Executor Observations into Native Mastra Agent Observability
status: superseded
owners:
  - core
created: 2026-09-07
updated: 2026-09-18
upstream:
  - rfc.execution-observability-and-debugging
supersedes: []
---

# Project Executor Observations into Native Mastra Agent Observability

> Superseded by [adr.engine-opaque-agent-adapter-contracts](./2026-09-18-engine-opaque-agent-adapter-contracts.md).
> This record remains historical context for the native projection decision.

## Context

Seqlane owns the semantic observability model for execution. The execution
RFC requires OpenCode activity to be translated into Seqlane concepts and
keeps Mastra tooling implementation-only. The public workflow, Plan, event,
and runner boundaries must remain Mastra-free.

The Mastra-backed runtime already owns the private agent-adapter integration.
Each concrete executor adapter has the semantics needed to translate its own
observations. OpenCode exposes model responses and agent activity with useful
provider, token, cache, reasoning, cost, tool, and skill information. Keeping
only aggregate invocation metrics loses per-response identity and does not
provide native agent, model, and tool metrics.

The active Mastra workflow step changes for each invocation. A run/session
factory context therefore cannot carry the complete observability parent. The
private per-invocation adapter request must receive the current Mastra
`ObservabilityContext` so the concrete adapter can attach its spans to the
correct step.

## Decision

The concrete runtime executor adapter owns its executor-specific Mastra
observability bridge. OpenCode understands the public `message.updated` and
`message.part.updated` contracts and directly creates, updates, and ends
native Mastra spans. ACP and future adapters own their equivalent mappings.

The private `AgentAdapterRequest` exposes the invocation's Mastra
`Partial<ObservabilityContext>` as a required request field. The runtime
retains the context in `MastraPlanInvocationContext` and passes it through to
each request. `RuntimeAdapterFactoryContext` remains run/session-scoped and is
not a substitute for this per-invocation context. When tracing is active, the
concrete adapter uses the current span from the request context as the parent.
An absent current span makes instrumentation a no-op, not execution a failure.

Mastra's workflow `ExecuteFunctionParams` already extends
`Partial<ObservabilityContext>`. Runtime execution preserves those fields as
one required private request value and lets the adapter reuse the current
Mastra `WORKFLOW_STEP` when available. The adapter does not synthesize a
separate workflow-step span or use Mastra as a detached external metrics sink.

The span hierarchy is:

```text
WORKFLOW_STEP (current Mastra step for this invocation)
  └── AGENT_RUN
        ├── MODEL_GENERATION (one per assistant message)
        │     └── TOOL_CALL (when the message owns the tool part)
        ├── TOOL_CALL (when no model parent is available)
        └── SKILL_RESOLUTION (only for a dynamic skills-resolver run)
```

Each actual assistant message creates one `MODEL_GENERATION`, including every
structured-output repair response. OpenCode `skill` activity is a
`TOOL_CALL` with `toolType: "skill"`; `SKILL_RESOLUTION` is reserved for an
actual dynamic agent skills-resolver lifecycle. Mastra derives native agent,
tool, model duration, token, and cost-context metrics from these spans.
Seqlane retains its aggregate invocation metrics separately.

The concrete adapter keeps bounded, private correlation metadata for Work, Run,
Invocation, session, and message/generation identities. It does not change
the public authoring API, Plan IR, serialized execution-event contract, or
runner protocol.

## Alternatives considered

### Attach metrics metadata only to the workflow step

Rejected. A single workflow-step span cannot represent each model response,
repair attempt, tool invocation, or skill activity, so Mastra cannot derive
native per-operation metrics or preserve the required correlation.

### Emit manual metric rows

Rejected. Manual rows lose Mastra's native span hierarchy, lifecycle, and
automatic duration/token/cost derivation, and require a second correlation
model.

### Add a generic OpenCode-independent runtime projector

Rejected. Executor event identity, lifecycle, fallback, and usage semantics
belong to the concrete adapter. A generic projector would either lose those
semantics or reintroduce executor-specific branching in a shared layer.

### Couple public Seqlane contracts directly to Mastra

Rejected. Mastra types in `seqlane-core`, `seqlane-events`, workflow APIs,
Plans, or runner IPC would make implementation tooling authoritative and
break executor-neutral portability. Mastra remains allowed only in the
private runtime and agent-adapter integration.

### Export raw OpenCode transcripts

Rejected. Raw transcripts are not a stable metric contract, may contain
secrets or sensitive prompts/tool payloads, and make redaction, bounds, and
correlation unreliable.

## Consequences

### Positive

- The concrete adapter can preserve executor-specific event identity and
  lifecycle semantics while emitting native Mastra spans.
- Mastra provides native agent, tool, model duration, token, and cost-context
  metrics.
- Every actual model response remains individually attributable, including
  structured-output repairs.
- Per-invocation context follows the active workflow step and supports exact
  correlation across repeated invocations in one run.
- Public Seqlane contracts remain executor-neutral and Mastra-free.

### Negative

- Each concrete adapter must implement and test its own Mastra mapping.
- The private adapter request must propagate Mastra context through runtime
  execution without exposing it in public contracts.
- OpenCode event and terminal-response coverage must be reconciled and
  deduplicated.
- Span lifecycle handling is required for cancellation, disconnect, and later
  task failure.
- Mastra storage/export configuration, sampling, and version compatibility
  remain operational concerns for the Mastra-backed runtime.

## Traceability

- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.consumer-agnostic-seqlane-execution-events: Define Consumer-Agnostic Seqlane Execution Events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events: Consumer-Agnostic Seqlane Execution Events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [adr.executor-neutral-workflow-authoring: Keep Workflow Authoring and Plans Executor-Neutral](./2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.opencode-executor-integration: Integrate OpenCode Through a Seqlane-Owned Executor Boundary](./2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration: OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
