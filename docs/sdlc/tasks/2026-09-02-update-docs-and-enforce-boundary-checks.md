---
id: task.update-docs-and-enforce-boundary-checks
title: Update docs and enforce boundary checks
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.executor-neutral-workflow-authoring
supersedes: []
---

# Update docs and enforce boundary checks

> Migrated from implementation story `TS-008-05`.

## Use Case

**As a** Seqlane maintainer, **I want to** document generic authoring and block future executor leaks, **so that** users and contributors keep the adr.executor-neutral-workflow-authoring boundary.

## Scope

- Update spec.seqlane-plan-ir-typed-dataflow, spec.opencode-executor-integration, MVP, adr.repository-user-workflow-discovery-and-composition, package READMEs, CLI examples, and architecture index for executor-neutral authoring and both task work kinds.
- Add source, export, Plan, protocol, CLI-help, fixture, and documentation boundary checks.
- Document OpenCode only as a private runtime adapter where needed.
- Update the root `AGENTS.md` boundary guidance if it differs from adr.executor-neutral-workflow-authoring.

## Out of Scope

- Rewriting historical ADR decisions beyond permitted lifecycle notes.
- Publishing public adapter APIs or a public executor plugin system.
- New executor capabilities or operator configuration UX.

## Implementation Notes

The source checks must fail on OpenCode or Mastra terms at public boundaries. They can allow private adapter implementation and adapter-specific tests. Documentation checks must show public `agent` and `operation` work without provider, endpoint, client, or credential details. They must cover supported workflow examples, CLI help, runtime configuration, package READMEs, TS documents, and adr.repository-user-workflow-discovery-and-composition.

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

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.repository-user-workflow-discovery-and-composition — Support Repository and User Scoped Composition Using Ordinary TypeScript](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
- [adr.executor-neutral-workflow-authoring — Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [spec.executor-neutral-workflow-authoring — Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
- [MVP — Minimal Configuration](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.executor-neutral-workflow-authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
