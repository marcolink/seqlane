# TS-001-03 — Preserve Seqlane input and output semantics across execution

**Status:** completed


## Use Case
**As a** task author, **I want to** use Seqlane bindings and schemas for task data, **so that** each executor receives validated input and produces a validated result independent of Mastra state.

## Acceptance Criteria
**Scenario:** *Task input is resolved and validated*
- **Given:** A TaskNode contains input bindings that reference workflow input or a prior invocation result
- **When:** Its generated step executes
- **Then:** Seqlane resolves the bindings, traverses the referenced path, and validates the resulting input with the Seqlane task schema before invoking the executor

**Scenario:** *Task output is validated and retained*
- **Given:** An executor returns a raw output for a TaskNode
- **When:** The generated step completes
- **Then:** Seqlane validates the output and stores it in `ExecutionContext.results` under the invocation ID

## Technical Details
Binding resolution is Seqlane-owned. A reference has the conceptual shape `{ type: "ref", invocationId, path }`; Mastra does not interpret `ValueRef` or carry semantic Seqlane values between steps.

## Out of Scope
- Using Mastra workflow state for task outputs or bindings
- Changing the public Seqlane Plan or `ValueRef` model
- Persisting `ExecutionContext`

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
