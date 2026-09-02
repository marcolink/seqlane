# TS-002-07 — Validate the runner boundary with the MVP workflow contract

**Status:** completed


## Use Case
**As a** Seqlane maintainer, **I want to** validate the complete child-process boundary with a representative workflow, **so that** the MVP proves isolated execution, event transport, failure handling, and cancellation together.

## Acceptance Criteria
**Scenario:** *Renovate-shaped workflow executes through the child*
- **Given:** The Renovate-shaped `investigate → plan → fix → verify` fixture and mocked OpenCode execution
- **When:** The CLI launches the runner and sends a `RunRequest`
- **Then:** The runner imports and executes the workflow through TS-001, the CLI receives the expected event sequence, and the command returns the Seqlane-owned result

**Scenario:** *Boundary failure and cancellation are covered*
- **Given:** The fixture is configured for an invocation failure or active cancellation
- **When:** The child-boundary integration test runs
- **Then:** Downstream work stops or abort reaches the fake executor, the terminal event is correct, and all workspace quality checks pass

## Technical Details
The contract suite should use a real child process and fake executor/OpenCode adapter. It must verify JSON-only messages, one terminal event, fresh-process behavior, normalized errors, event rendering, and signal forwarding.

## Out of Scope
- A real OpenCode server in automated tests
- Production deployment or service orchestration
- Persistence, replay, OTEL, or a debugger UI

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
- [MVP — Success Criteria](../../MVP.md)
