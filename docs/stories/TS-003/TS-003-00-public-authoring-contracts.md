# TS-003-00 — Define public authoring contracts

**Status:** completed

## Use Case

**As a** Seqlane author, **I want to** define a typed Seqlane task and workflow using core-only contracts, **so that** authoring is independent of the private runtime engine.

## Scope

- Add Mastra-independent core types and factories for task definitions, workflow definitions, invocation results, and task schema registries.
- Keep definitions and schemas in memory; do not add them to `Plan`.
- Export only intentional public API from `@seqlane/core`.

## Out of Scope

- Proxy-backed nested references.
- Plan construction or runtime loader changes.
- Any Mastra, OpenCode, or executor implementation API.

## Implementation Notes

Reuse `SeqlaneSchema<T>` as the schema boundary. A task has stable task and executor identities plus typed input/output schemas. A workflow has stable identity, input/output schemas, and a plan-building callback. All contracts must be representable without importing runtime code.

## Acceptance Criteria

**Scenario:** *Public authoring contracts are core-owned*
- **Given:** A consumer imports `@seqlane/core`
- **When:** It defines a typed task and workflow
- **Then:** The definitions preserve input and output generic types and the core package remains free of Mastra dependencies and types

**Scenario:** *Plans remain serializable data*
- **Given:** A task or workflow definition contains schemas and callbacks
- **When:** A Plan is produced later
- **Then:** The Plan contains neither schemas nor callbacks and has no runtime-engine field

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-003 — Use a Seqlane-Owned Plan IR with Typed Dataflow](../../ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [TS-003 — Seqlane Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
