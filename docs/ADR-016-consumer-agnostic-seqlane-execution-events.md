# ADR-016 — Define Consumer-Agnostic Seqlane Execution Events

**Status:** Accepted
**Scope:** Canonical execution events, event consumers, and execution-plan snapshots
**Related:** ADR-002, ADR-011, ADR-013, RFC-002

## Context

Seqlane currently has two event models. `SeqlaneEvent` is an in-process
runtime contract in `seqlane-core`. `RunnerEvent` is the serialized,
metadata-bearing contract sent across the dedicated runner boundary. The
runtime translates the former into the latter, and the CLI forwards the latter
to terminal output and local Studio.

The serialized event stream is no longer only a runner or Studio concern. The
same execution must support terminal output, CI output, JSON output, local
Studio, recordings and replay, and future OpenTelemetry or other observability
adapters. Consumers must receive the same Seqlane-owned semantic events.

The current `RunnerEvent` name couples the canonical event contract to one
transport producer. The current `StudioIngestEvent` is correctly
Studio-specific, but there is no explicit generic consumer contract or
dispatcher boundary.

Studio also needs a static execution-plan snapshot. Invocation events describe
actual execution instances and cannot represent uninstantiated repeat-body
nodes or a run that fails before invocation creation.

## Decision Outcome

Seqlane will create a public, executor-neutral package named
`@seqlane/events`.

The package will own:

- the canonical serializable `SeqlaneExecutionEvent` union;
- event metadata, identities, and schema versioning;
- event guards and JSON encoding/decoding;
- the `SeqlaneExecutionEventConsumer` contract; and
- the sanitized `run.plan` execution-plan snapshot event.

`SeqlaneExecutionEvent` replaces `RunnerEvent` as the canonical name. The
runner remains one producer and one transport boundary, not the owner of the
semantic event model.

`seqlane-core` will retain workflow-authoring contracts, Plan IR, shared
primitives, and runner commands. The in-process runtime event contract may be
renamed or made private to `seqlane-runtime`; it will not be used as the
recording, Studio, output, or external-consumer contract.

The CLI will own event fanout and lifecycle wiring. It will attach independent
consumers for:

```text
SeqlaneExecutionEvent
  ├── @seqlane/output renderer
  ├── Studio publisher
  ├── recording writer
  └── future observability adapters
```

`@seqlane/output` remains a renderer package. It will consume
`SeqlaneExecutionEvent`, but it will not be renamed or broadened into a
generic event-consumer package. Its existing human, CI, and JSON projections
remain its responsibility.

## Execution Plan Snapshot

The canonical stream will add a `run.plan` event after `run.started` and after
the runner has loaded and validated the actual Plan:

```text
run.started
run.plan
invocation.created
invocation.progress
...
```

The event will carry a sanitized graph descriptor, not the raw Plan. It will
contain stable Plan-node IDs, node kinds, labels or task identities, static
dependencies, containment, sibling order, and repeat metadata. It will not
contain literal input values, callbacks, schemas, credentials, prompts, or
executor data.

Studio will keep static Plan-node identity (`planNodeId`) separate from actual
execution identity (`invocationId`). It will render the static graph first and
overlay actual invocation state as invocation events arrive. It must not
fabricate invocation IDs for planned but uninstantiated nodes.

Recordings will preserve `run.plan` alongside all execution events so replay
can render the complete graph even when execution produced few or no
invocation events.

## Standards Alignment

The Seqlane event model remains the lossless domain/debugging model. It will
not be replaced by OpenTelemetry or CloudEvents.

OpenTelemetry adapters may map runs and invocations to spans, lifecycle data
to span events or logs, and metrics to OTel metrics. Optional W3C trace context
may be carried without replacing Seqlane Work, Run, or Invocation IDs.

CloudEvents may wrap Seqlane events for external event transports. CloudEvents
is an interoperability envelope, not the source of Seqlane lifecycle,
dependency, validation, or provenance semantics.

## Options Considered

### Keep canonical events in `seqlane-core`

This avoids a package move and `seqlane-core` is already public,
executor-neutral, and dependency-light. It leaves authoring, Plan IR, internal
runtime events, and serialized execution events in one package, however, and
keeps the transport-oriented `RunnerEvent` name. Rejected as the long-term
boundary.

### Make Studio the canonical event owner

This would optimize for the current graph renderer but couple output,
recording, CI, and future observability to Studio. Rejected.

### Use OpenTelemetry as the canonical event model

OpenTelemetry provides standard telemetry primitives, but sampling, export
semantics, and span/log projections are unsuitable as the lossless Seqlane
execution and replay contract. Rejected.

### Use CloudEvents as the canonical event model

CloudEvents provides portable event context and transport interoperability, but
does not define Seqlane invocation, dependency, validation, or provenance
semantics. Rejected as the internal model; retained as a future adapter.

### Create `@seqlane/events`

This gives the event contract an explicit public boundary, allows independent
consumers, keeps presentation and transport concerns separate, and provides a
stable home for recording and future observability adapters. Chosen.

## Consequences

### Positive

- Studio, output, recording, and future observability use one event contract.
- The CLI can attach consumers without consumer-specific runner changes.
- Event consumers can fail independently without changing run outcomes.
- Recordings capture the complete static Plan graph and actual execution.
- OpenTelemetry and CloudEvents integrations remain replaceable adapters.
- `seqlane-output` remains focused on presentation and terminal behavior.

### Negative

- Existing `RunnerEvent` imports and package exports must migrate.
- A new public package and versioned contract must be maintained.
- The runtime must project internal events into the canonical event package.
- Static Plan nodes and actual invocations require distinct Studio view-model
  identities.
- The event contract needs explicit redaction, size, compatibility, and
  forward-evolution rules.

## Follow-Up Constraints

- `@seqlane/events` must not depend on Mastra, OpenCode, Studio, or
  terminal-rendering libraries.
- Canonical events must be JSON serializable and safe for recording/export
  after Seqlane redaction and bounds policies have run.
- `seqlane-output` remains named and scoped as an output/rendering package.
- The CLI dispatcher must preserve per-consumer ordering and isolate consumer
  failures.
- `run.plan` must be emitted by the runner using the actual loaded Plan.
- Static Plan identity and actual invocation identity must never be conflated.
- Record/replay must remain inspection-only; it must not resume execution.
- OpenTelemetry and CloudEvents adapters must not become dependencies of the
  canonical event package.

## Revisit Conditions

Revisit this decision if the event contract becomes inseparable from workflow
authoring, if a separate distributed event platform becomes authoritative, or
if external consumers require a different compatibility/versioning boundary.
