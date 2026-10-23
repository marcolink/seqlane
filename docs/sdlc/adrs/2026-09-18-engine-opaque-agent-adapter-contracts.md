---
id: adr.engine-opaque-agent-adapter-contracts
title: Keep Generic Agent Adapter Contracts Engine-Opaque
status: superseded
owners:
  - core
created: 2026-09-18
updated: 2026-10-22
upstream:
  - rfc.execution-observability-and-debugging
  - adr.opencode-executor-integration
supersedes: []
---

# Keep Generic Agent Adapter Contracts Engine-Opaque

> Superseded by [the Effect runtime decision](../rfcs/2026-10-21-effect-v4-migration.md).
> The retained boundary rationale is recorded below. Current observation and
> context ownership belongs to [the adapter observation contract](../specs/2026-10-22-adapter-observation-projection.md#requirement-boundary-and-context).

## Context

The generic agent-adapter contract exposed a runtime instrumentation type to
every adapter implementation. That coupling conflicted with the generic
boundary. Runtime mechanisms and native SDK details need separate owners.
Observability must preserve invocation correlation without making those
implementation types part of the shared execution contract.

## Decision

The original decision hid runtime instrumentation behind an opaque private
handoff. It kept runtime types out of the generic adapter package, but still
required concrete adapters to participate in runtime trace projection.

The replacement removes that handoff and the adapter-owned trace tree.
Adapters emit validated canonical observations. Runtime telemetry projects
those observations and owns tracing resources. The generic boundary remains
engine-independent; this historical record defines no current request fields.

## Alternatives considered

### Expose runtime instrumentation types in the generic adapter package

Rejected. The package is generic by design. A private package boundary is not
sufficient reason to couple every adapter to runtime instrumentation.

### Remove correlation at the integration boundary

Rejected. Detailed observations still need the correct invocation and native
parent relationships. The replacement preserves them through canonical events
and owned context propagation.

### Define a generic observability interface

Rejected. A shared interface would either recreate runtime instrumentation or add a
second, lossy span abstraction. The original decision kept private projection
in concrete adapters. The replacement keeps native SDK validation and event
reduction there; runtime telemetry owns span projection.

## Consequences

- The generic adapter contract remains independent of runtime and native SDK types.
- Concrete adapters own source validation, identity, and lifecycle reduction.
- Runtime owns telemetry projection, exporters, and shutdown.
- Boundary tests must reject runtime or native SDK type leaks from generic contracts.

## Delivery state

Superseded architecture decision. Its original implementation was tracked by
`task.decouple-runtime-adapter-composition`; this document does not claim
delivery on the target branch.

## Traceability

- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.opencode-executor-integration: Integrate OpenCode Through a Seqlane-Owned Executor Boundary](./2026-09-02-opencode-executor-integration.md)
- [Replacement runtime decision](../rfcs/2026-10-21-effect-v4-migration.md)
- [spec.agent-adapter-boundary-and-capabilities: Agent Adapter Boundary and Capability Model](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.adapter-observation-projection: Adapter Observation Lifecycle and Projection](../specs/2026-10-22-adapter-observation-projection.md)
- [task.decouple-runtime-adapter-composition: Decouple Runtime from Concrete Adapter Implementations](../tasks/2026-09-16-decouple-runtime-adapter-composition.md)
