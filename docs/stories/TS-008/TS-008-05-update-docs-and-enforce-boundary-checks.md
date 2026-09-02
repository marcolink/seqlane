# TS-008-05 — Update docs and enforce boundary checks

**Status:** completed

## Use Case

**As a** Seqlane maintainer, **I want to** document generic authoring and block future executor leaks, **so that** users and contributors keep the ADR-008 boundary.

## Scope

- Update TS-003, TS-004, MVP, ADR-006, package READMEs, CLI examples, and architecture index for executor-neutral authoring and both task work kinds.
- Add source, export, Plan, protocol, CLI-help, fixture, and documentation boundary checks.
- Document OpenCode only as a private runtime adapter where needed.
- Update the root `AGENTS.md` boundary guidance if it differs from ADR-008.

## Out of Scope

- Rewriting historical ADR decisions beyond permitted lifecycle notes.
- Publishing public adapter APIs or a public executor plugin system.
- New executor capabilities or operator configuration UX.

## Implementation Notes

The source checks must fail on OpenCode or Mastra terms at public boundaries. They can allow private adapter implementation and adapter-specific tests. Documentation checks must show public `agent` and `operation` work without provider, endpoint, client, or credential details. They must cover supported workflow examples, CLI help, runtime configuration, package READMEs, TS documents, and ADR-006.

## Acceptance Criteria

**Scenario:** *Supported docs describe generic authoring*
- **Given:** The mutable Seqlane documents and READMEs
- **When:** A contributor reads workflow, Plan, runtime, and CLI guidance
- **Then:** They find agent and operation task authoring plus runtime profiles without OpenCode-specific workflow or CLI configuration

**Scenario:** *Boundary checks block new leaks*
- **Given:** A change that adds an OpenCode or Mastra term to a public core export, workflow source, Plan, runner IPC, CLI help, or supported example
- **When:** The boundary suite runs
- **Then:** It fails with the leaking path and boundary

**Scenario:** *Private adapter code remains permitted*
- **Given:** The private OpenCode adapter and its contract tests
- **When:** The boundary suite runs
- **Then:** It permits required private SDK and server references without allowing them in public surfaces

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-006 — Support Repository and User Scoped Composition Using Ordinary TypeScript](../../ADR-006-repository-user-workflow-discovery-and-composition.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-003 — Seqlane Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
- [TS-004 — OpenCode Executor Integration](../../TS-004-opencode-executor-integration.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
- [MVP — Minimal Configuration](../../MVP.md)
