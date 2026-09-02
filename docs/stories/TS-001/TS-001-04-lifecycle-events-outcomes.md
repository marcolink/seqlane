# TS-001-04 — Expose Seqlane-owned lifecycle events and outcomes

**Status:** completed


## Use Case
**As a** workflow operator, **I want to** receive Seqlane-owned lifecycle events and normalized run outcomes, **so that** I can observe execution without depending on Mastra types or streams.

## Acceptance Criteria
**Scenario:** *Invocation lifecycle is observable*
- **Given:** A generated Seqlane step starts, succeeds, or fails
- **When:** The corresponding invocation transition occurs
- **Then:** The runtime emits the appropriate Seqlane event through `ExecutionContext.events` with the run and invocation identity

**Scenario:** *Mastra outcomes are mapped to Seqlane outcomes*
- **Given:** A compiled workflow completes successfully or fails
- **When:** The runtime maps the result
- **Then:** Success returns the Seqlane workflow result and failure returns a normalized Seqlane error without exposing a Mastra result type

## Technical Details
The event sink emits Seqlane events such as `invocation.started`, `invocation.succeeded`, and `invocation.failed`. Errors are normalized into Seqlane categories including `InputValidationError`, `ExecutorError`, `OutputValidationError`, and `RuntimeError`.

## Out of Scope
- Using the Mastra stream as the public observability protocol
- Mastra Studio
- Mastra telemetry as Seqlane telemetry

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
