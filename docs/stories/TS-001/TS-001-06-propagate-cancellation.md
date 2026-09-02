# TS-001-06 — Cancel an active workflow and propagate abort

**Status:** completed


## Use Case
**As a** workflow operator, **I want to** cancel an active workflow, **so that** the running executor can stop work promptly and safely.

## Acceptance Criteria
**Scenario:** *Cancellation reaches the active executor*
- **Given:** A compiled Mastra run is active and a Seqlane runner receives `CancelRun`
- **When:** The runtime processes the cancellation
- **Then:** Cancellation propagates from the Mastra run to the generated step `AbortSignal` and into the Seqlane Executor

**Scenario:** *Cancellation remains behind the Seqlane boundary*
- **Given:** The executor observes the abort signal
- **When:** The active operation terminates
- **Then:** The runtime handles cancellation through Seqlane’s runner path without exposing Mastra objects or cancellation types to consumers

## Technical Details
The expected propagation path is `CancelRun → Mastra cancellation → step AbortSignal → Seqlane Executor → OpenCode abort`. Suspend/resume and persisted workflow features are not used.

## Out of Scope
- Suspend/resume
- Mastra persistence
- Durable or multi-process cancellation recovery

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
