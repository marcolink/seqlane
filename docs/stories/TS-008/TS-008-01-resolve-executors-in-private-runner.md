# TS-008-01 — Resolve executors in the private runner

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want to** have the runner privately resolve generic tasks to executors, **so that** workflow source and Plans cannot choose a backend.

## Scope

- Replace the executor-name registry with a private agent resolver in runtime internals.
- Pass the generic in-memory task registry to compilation and execution.
- Resolve each task before executor invocation.
- Map a missing private binding to the existing Seqlane executor failure path.
- Remove `createRunnerExecution` from workflow module loading and exported workflow contracts.
- Keep resolver types out of package-root exports and runner IPC.

## Out of Scope

- OpenCode adapter implementation or runtime profile format.
- CLI flags and public protocol fields.
- Multiple executor selection policies or fallback.
- Public executor registration.

## Implementation Notes

The resolver is runner-owned private state. It receives an agent task definition and returns a private executor. The runtime resolves and validates input before execution and validates output after execution. A missing mapping must identify the Seqlane task ID without exposing private adapter details.

## Acceptance Criteria

**Scenario:** *The runner resolves a generic task privately*
- **Given:** A loaded workflow with agent task definitions and a private resolver
- **When:** The runtime executes a task node
- **Then:** It calls the private executor without reading an executor field from the Plan

**Scenario:** *A missing binding fails deterministically*
- **Given:** A generic task with no private executor binding
- **When:** The runtime reaches its node
- **Then:** It emits the existing invocation and Run failure events as an executor failure and starts no downstream task

**Scenario:** *Workflow modules expose no execution factory*
- **Given:** A workflow module that exports only a generic workflow
- **When:** The runner loads the module
- **Then:** It builds the Plan and obtains private execution state from the runner, not from a module `createRunnerExecution` export

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-001 — Use Mastra as Seqlane’s Internal Workflow Engine](../../ADR-001-mastra-internal-workflow-engine.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
