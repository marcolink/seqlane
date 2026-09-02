# TS-004-01 — Define typed OpenCode tasks

**Status:** completed

## Use Case

**As a** Seqlane workflow author, **I want to** define an OpenCode task with typed input, typed output, an objective, and additive context, **so that** I can compose repository-aware coding work without SDK concepts.

## Scope

- Add the intentional public OpenCode task factory in `@seqlane/opencode`.
- Define the in-memory task metadata for an objective, optional instructions, textual references, and structured-output schema provider.
- Preserve input and output inference without casts or manual generic parameters.
- Retain OpenCode task definitions in a core-owned in-memory registry that a runner can resolve by task ID.
- Keep the registry and all OpenCode metadata out of serialized Plans and runner IPC.

## Out of Scope

- Creating an SDK client or OpenCode session.
- Calling an OpenCode server.
- Model, provider, agent, tool, or permission options.
- Native Harness Overlay capabilities.

## Implementation Notes

The factory returns a core-compatible task with executor ID `"opencode"`. Its objective receives already validated task input at execution time. The structured-output provider must produce the JSON schema required by TS-004-00. A workflow module can create a runner-execution factory from its workflow definition without a separate task-registration list.

## Acceptance Criteria

**Scenario:** *Typed task authoring needs no OpenCode SDK value*
- **Given:** A task input and output schema
- **When:** An author defines and invokes an OpenCode task in a workflow
- **Then:** TypeScript infers the input, output, and downstream `ValueRef` types without a cast, generic argument, client, session ID, or model ID

**Scenario:** *Task metadata stays in memory*
- **Given:** An authored OpenCode task with objective, instructions, references, and a structured-output schema provider
- **When:** The workflow builds a Plan or sends runner IPC
- **Then:** The Plan and IPC contain only Seqlane data, while the runner can resolve the task metadata by task ID

**Scenario:** *Invalid structured-output metadata fails early*
- **Given:** A task without a valid schema provider for its declared output
- **When:** The runner prepares OpenCode execution
- **Then:** It fails before the adapter sends a request

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-004 — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../../ADR-004-opencode-executor-integration.md)
- [TS-004 — OpenCode Executor Integration](../../TS-004-opencode-executor-integration.md)
- [MVP — Strong Typing](../../MVP.md)
