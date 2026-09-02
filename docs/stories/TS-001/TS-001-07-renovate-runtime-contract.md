# TS-001-07 — Prove the MVP runtime with a Renovate-shaped workflow

**Status:** completed


## Use Case
**As a** Seqlane maintainer, **I want to** verify a representative workflow through the real Mastra package, **so that** the MVP runtime contract is proven end to end before broader control-flow work begins.

## Acceptance Criteria
**Scenario:** *Representative workflow executes end to end*
- **Given:** A Renovate-shaped workflow contains `investigate → plan → fix → verify` and uses mocked OpenCode execution
- **When:** The runtime executes the workflow through the real Mastra package
- **Then:** The workflow completes in the expected order and returns a Seqlane-owned result

**Scenario:** *Representative failure behavior is verified*
- **Given:** A step in the Renovate-shaped workflow fails or is cancelled
- **When:** The integration test runs
- **Then:** Downstream execution stops or cancellation propagates to the fake executor as defined by the runtime contract

## Technical Details
The test suite includes compiler unit tests, runtime unit tests with a fake Executor, Mastra integration tests using the real package, and the Renovate-shaped contract fixture.

## Out of Scope
- Running against a real OpenCode server
- Deploying a Seqlane service
- Parallel, branching, looping, or durable workflow execution

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
