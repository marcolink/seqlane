# TS-001-05 — Stop failed workflows without automatic retries

**Status:** completed


## Use Case
**As a** workflow operator, **I want to** stop downstream execution when a task fails without silently retrying it, **so that** failures and side effects remain deterministic in the MVP.

## Acceptance Criteria
**Scenario:** *Failure stops downstream execution*
- **Given:** A workflow contains an ordered chain where an upstream invocation fails
- **When:** The runtime normalizes that failure
- **Then:** Downstream invocations do not execute and the run fails with a Seqlane error

**Scenario:** *Failed invocation is attempted once*
- **Given:** A generated Mastra step encounters an executor failure
- **When:** The step exits
- **Then:** The runtime performs one executor attempt and does not apply an automatic Mastra retry policy

## Technical Details
Exceptions leaving generated steps are converted with `toSeqlaneInvocationError`. Seqlane, rather than Mastra, owns retry safety and keeps retries disabled for the MVP.

## Out of Scope
- Effect-aware retry semantics
- Backoff or retry configuration
- Durable execution after failure

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
