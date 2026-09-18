---
id: adr.engine-opaque-agent-adapter-contracts
title: Keep Generic Agent Adapter Contracts Engine-Opaque
status: accepted
owners:
  - core
created: 2026-09-18
updated: 2026-09-18
upstream:
  - rfc.execution-observability-and-debugging
  - adr.opencode-executor-integration
supersedes:
  - adr.mastra-native-agent-observability
---

# Keep Generic Agent Adapter Contracts Engine-Opaque

## Context

The generic agent-adapter contract carried Mastra's
`Partial<ObservabilityContext>` directly. This made a runtime-engine type part
of a package shared by all adapter implementations. It conflicts with the
adapter boundary: the runtime must depend only on generic contracts, while
concrete integrations own their engine-specific details.

The runtime still needs to preserve the active Mastra workflow-step context.
OpenCode and ACP still need that context to create native spans. The issue is
where the type crosses the adapter boundary, not whether native observability
exists.

## Decision

The generic `AgentAdapterRequest.observability` and
`AgentRuntimeContext.requestContext` fields are required opaque `unknown`
values. `@seqlane/agent-adapter` must not import or expose Mastra types.

`@seqlane/runtime` retains Mastra's typed per-invocation context privately and
passes it unchanged as the opaque request value. A concrete adapter that
supports Mastra observability narrows that value at its own private integration
edge before reading the current span. It must treat an absent, malformed, or
conflicting context as no native instrumentation, without changing execution.

Concrete adapter projection rules remain unchanged: adapters own their source
validation, reducer, span parentage, lifecycle, data bounds, and failure
isolation. Public workflow APIs, Plans, events, runner IPC, and generic adapter
contracts remain Mastra-free.

## Alternatives considered

### Keep Mastra types in the generic private adapter package

Rejected. The package is generic by design. A private package boundary is not
sufficient reason to expose a runtime-engine type to every adapter.

### Erase the context in the runtime

Rejected. Concrete Mastra integrations need the active workflow-step parent to
produce correctly correlated native spans.

### Define a generic observability interface

Rejected. A shared interface would either recreate Mastra types or add a
second, lossy span abstraction. Adapter-specific projection semantics belong in
the concrete adapter.

## Consequences

- Runtime-only Mastra types stay inside `@seqlane/runtime`.
- Concrete adapter packages may import Mastra only for their local projection.
- The generic adapter package can support non-Mastra runtimes without a type
  dependency on Mastra.
- Concrete adapters must safely narrow the opaque context before use.
- Adapter and runtime boundary tests must reject Mastra imports or exported
  Mastra types from the generic adapter package.

## Delivery state

Accepted architecture decision. Its implementation is tracked by
`task.decouple-runtime-adapter-composition`; this document does not claim
delivery on the target branch.

## Traceability

- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.opencode-executor-integration: Integrate OpenCode Through a Seqlane-Owned Executor Boundary](./2026-09-02-opencode-executor-integration.md)
- [Previous observability decision](./2026-09-07-mastra-native-agent-observability.md)
- [spec.agent-adapter-boundary-and-capabilities: Agent Adapter Boundary and Capability Model](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](../specs/2026-09-07-mastra-native-agent-observability.md)
- [task.decouple-runtime-adapter-composition: Decouple Runtime from Concrete Adapter Implementations](../tasks/2026-09-16-decouple-runtime-adapter-composition.md)
