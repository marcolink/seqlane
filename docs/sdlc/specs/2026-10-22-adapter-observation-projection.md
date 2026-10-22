---
id: spec.adapter-observation-projection
title: Adapter Observation Lifecycle and Projection
status: active
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - rfc.effect-v4-migration
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Adapter Observation Lifecycle and Projection

## Summary

This contract owns retained adapter observation extraction, identity,
deduplication, lifecycle, and projection requirements. Protocol-owned canonical
observations remain the source of truth. Effect runtime telemetry and hosted
inspection consume those observations. This is a requirements transfer, not a
claim that historical deliveries used Effect.

## Goals

Preserve every available JSON/text value, truthful availability, stable
correlation, one source subscription, complete lifecycle, and outcome isolation.

## Non-goals

No duplicate native-adapter trace tree, invented model usage, implicit remote
export, public telemetry SDK contract, recorder, or durable replay is added.
The draft OTel mapping document supplies vocabulary and design background.
It does not activate a new wire field or change the existing protocol version.

## Requirements

### requirement-boundary-and-context

Concrete adapters own native validation, lifecycle reduction, stable native
identity translation, and canonical observation emission. Protocol owns the
observation schema, event envelope, sequencing, serialization, and version.
Runtime owns Effect span projection, exporters, sampling, flush, and storage.
Adapters do not own exporter shutdown or submit duplicate metric rows.

Public core, protocol, Plans, runner IPC, and the generic adapter contract
contain no engine or native SDK types. SDK execution ports contain no span API.
Generic requests carry no opaque runtime instrumentation context. Concrete
adapters must not import a runtime engine to create a separate native trace tree.
The active Effect invocation context flows through owned Promise/SDK edges;
no shared factory or session object caches an invocation's active span.
The validated process trace carrier preserves parentage across CLI workers.
Tracing disabled or sampled out does not change execution or canonical delivery.

### requirement-one-reducer

Each native observation has one owning Zod validation boundary and one
adapter-local lifecycle reducer. A streaming source has one consumer.
The reducer emits the canonical observation; activity, interaction,
background-process reporting, metrics, TUI, and trace projections derive from
accepted canonical events. No output feeds another output to reconstruct data.
Malformed native data is diagnosed and rejected when safe; it never creates
an unverifiable observation. Required canonical sink failure remains an
infrastructure failure under the runtime output contract.

### requirement-parentage-and-lifecycle

Runtime spans start before execution. A run contains workflow/invocation spans;
model exchanges, tools, and skills retain observed parent relationships and links.
One admitted adapter invocation keeps one lifecycle across output-repair attempts.
Each repair model request is a distinct exchange with a zero-based attempt index.
Queue wait is measured separately from admitted execution.

Create model or activity records only when the source exposes their identity
and lifecycle. Open records close descendant-first on success, failure,
cancellation, or observed disconnect. Repeated terminal signals are idempotent;
closed records never reopen. Already completed children remain complete if
later repair, task, or workflow work fails. Runtime ownership spans are never
closed by adapters.

Keep source start/end timestamps when available. Without source timing, use
receive time and report its origin. Do not fabricate backdated times or claim
that a projection duration equals an unavailable native duration.

### requirement-fidelity-and-availability

Preserve complete source request, response, context, instructions, schema,
options, reasoning, tool definitions, arguments/results, skill instructions,
metadata, errors, usage, cost, and lifecycle updates when JSON/text-representable.
Preserve empty strings/arrays, false, zero, null, object keys, and array order.
Task input and result remain distinct from model exchanges.

Availability records identify absent or non-JSON fields and their reason.
Do not invent model/provider identity, token values, cost unit, tool completion,
skill instructions, or successful termination. Source availability takes priority
over configured model names or aggregate summaries.

This complete local payload contract replaces former metadata-only capture
limits. Bounds on names, correlation, queues, or remote export cannot truncate
or summarize canonical payloads. Unsupported values remain explicitly unavailable.
Remote export requires explicit endpoint and payload policy under the runtime
contract; local capture does not imply permission to export remotely.

### requirement-bounded-correlation

Work, Run, Invocation, containment, iteration, attempt, exchange, activity,
source identity, and sequence remain trace/log correlation, never metric labels.
Raw content is never an identity, metric label, sampling key, or span name.
Metric labels remain bounded enums such as adapter, task kind, outcome, and
error category. One lifecycle contributes once to derived duration/usage metrics.
Aggregate invocation callbacks remain separate outputs, not per-message sources.

Source-owned Zod schemas validate observation identities and activity names.
Keep their exact canonical values. Projection names and correlation fields use
the current protocol bounds; metric labels remain fixed-cardinality categories.
Optional export applies serialized-byte budgets and whole-record omission with
diagnostics. Former private span-class aliases, name-normalization algorithms,
and adapter-projector record budgets are replaced integration details; they
must not restrict canonical capture or create a second trace tree.

### requirement-opencode-source

Subscribe once to the native event stream before submitting each prompt.
Filter to the active session, preserve source order, and reconcile repeated
updates by stable identity. Interaction and process activity share this consumer.
Assistant-message identity `(sessionID, messageID)` identifies one model exchange.
Tool identity `(messageID, callID)` identifies one tool lifecycle. Updates
modify the same record. Known tools parent to their model exchange; otherwise
they parent to the invocation without inventing a model.

Pending/running tools open or update; completed/error tools settle once.
An open tool at attempt termination closes incomplete, failed, or cancelled.
A native skill load remains tool/skill activity, distinguishable from an ordinary
tool. It is not a dynamic skill-resolver execution unless that lifecycle was
actually observed. Preserve available skill identity, instructions, input,
output, and metadata. Preserve native skill identity when available; when absent, report availability
and retain the source activity name without inventing loaded skill instructions.

Reconcile the validated terminal prompt response before emitting another model
exchange. A matching assistant identity updates its existing exchange. When
identity coverage is safely incomplete, create at most one invocation-local
fallback generation. Repeated terminal handling is idempotent. Malformed
terminal output follows the existing typed execution error path.

Preserve per-message provider/model, input/output/reasoning tokens, cache-read
and cache-write values, and executor-reported cost with its source and verified
unit. Missing values remain unavailable. Aggregate invocation totals never
become per-message usage; do not reprice or invent a currency. Where the source
cannot establish a unit, report that availability instead of claiming one.

Existing invocation metric totals count every observed completed model response
once, including output-repair responses. A later response cannot overwrite an
earlier response's duration, cost, or available token counters. Preserve model
and provider identity only when consistent across those responses; otherwise
report that identity as unavailable. Keep observed totals when terminal failure
or cancellation follows a paid response. These aggregate outputs remain separate
from per-message observations and add no new wire fields.

Cancellation aborts the native prompt and closes open observations once.
Structured-output validation/repair, interaction errors, native authentication,
repository instructions, permissions, tools, plugins, and MCP behavior stay
adapter-owned and authoritative. StructuredOutput remains usable for schemas
without requiring workspace writes.

### requirement-acp-source

Use the official ACP SDK for supported protocol negotiation, session creation,
model-option negotiation, permissions, prompts, cancellation, and notifications.
Unsupported capabilities fail preflight; never substitute another adapter or
model. Adapter admission is bounded and cancellation-aware. Waiting cancellation
starts no external prompt or admitted agent lifecycle.

Preserve full validated ACP session notifications and native tool updates.
Tool identity includes `(invocationId, attemptIndex, externalToolCallId)`.
Validate source IDs before correlation and retain update/terminal idempotence.
Repeated progress updates retain one record. A result with no known start follows
the native malformed-sequence policy; conflicting or late terminal updates are
diagnosed with a bounded budget and never reopen records.
Tool terminal success comes only from an observed terminal result. At attempt
end close open tools as incomplete, failed, or cancelled before repair or return.
Use the source-owned ACP activity naming and availability contract.

Text chunks and request configuration do not prove a model exchange, underlying
model, or per-call usage. Never emit a wrapper name as provider/model identity
or count synthetic zero usage as observed tokens. Preserve context-occupancy,
window-size, and cumulative session cost as native usage values, with currency.
They are distinct from billed per-call input/output tokens and cost.
`acp.session.usage` retains its complete `model.usage` notification including
`sessionId`, `update`, and optional `_meta`. State unavailable model identity
and per-call usage explicitly. The configured model is requested configuration.

### requirement-failure-isolation

Span create/update/close and diagnostic operations cannot throw into execution.
On projection failure, best-effort close owned handles, clear projection state,
and emit one bounded no-throw diagnostic; diagnostic failure never recurses.
Projection failure cannot suppress canonical events, activity, metrics, output,
or the execution outcome. Runtime owns bounded telemetry queues, omitted-record
diagnostics, flush, and exporter failure isolation.

Required canonical event delivery has its own acknowledgement and byte bounds.
Do not confuse an optional exporter outage with a required sink failure.
Prove persisted hosted inspection with real store/restart tests; deterministic
span sinks alone do not establish storage or inspection visibility.

## Verification

Test one source subscription, validation/fan-out, stable IDs, parentage,
repair attempts, duplicate/late updates, received/source timing, missing model
usage, cost units, skill payloads, cancellation, disconnect, leaf-first closure,
name bounds, malformed data, JSON round trips, and projection/export failure.
Prove complete values survive adapter, protocol, CLI/TUI, and hosted inspection.
Verify real Effect span/metric/log output, explicit-only remote export, real
hosted persistence/restart, and public declarations without engine/SDK types.

## Acceptance criteria

One canonical protocol event feeds every projection without payload loss.
Each observable lifecycle has one stable identity and truthful terminal state.
Missing native fields remain explicitly unavailable. Projection/export errors
cannot change task results or required event delivery.

## Delivery state

Current contract transferred during S12. S5, S6, S8, and S10 own their scoped
implementation evidence. Final removal, distributions, and exact-head CI remain
with the S12 release gate.

## Traceability

- [rfc.effect-v4-migration: Runtime architecture](../rfcs/2026-10-21-effect-v4-migration.md)
- [spec.agent-adapter-boundary-and-capabilities: Generic adapter contract](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [Effect execution, telemetry, and hosted operations](./2026-10-21-effect-v4-execution-and-operations.md)
- [Draft observation vocabulary and OTel mapping](./2026-09-19-otel-aligned-observation-contract.md)
- [Work and invocation identity](./2026-09-02-work-run-invocation-identity-model.md)
- [Native adapters](../tasks/2026-10-21-effect-v4-native-adapters-and-observations.md)
- [Official ACP transport](../tasks/2026-10-21-effect-v4-acp-transport.md)
- [Telemetry and event pressure](../tasks/2026-10-21-effect-v4-telemetry-and-event-pressure.md)
- [Hosted inspection](../tasks/2026-10-21-effect-v4-hosted-history-and-inspection.md)
