---
id: task.migrate-examples-documentation
title: Migrate Examples and Authoring Documentation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.fluent-seqlane-flow-dsl
supersedes: []
---

# Migrate Examples and Authoring Documentation

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-012-06`.

## Use Case

**As a** Seqlane author, **I want** maintained examples and documentation for
the Flow DSL, **so that** I can use the public API without runtime details.

## Scope

- Migrate the built-in example workflow to the task-only Flow DSL.
- Update core and runtime READMEs with supported Flow DSL guidance.
- Document repeat limits, post-condition behavior, and V1 exclusions.
- Add source and package-boundary tests for the new public API.
- Run the full repository verification gate.

## Out of Scope

- New CLI options, executor configuration, or runner protocol fields.
- Migration of unrelated fixtures or historical ADRs.

## Implementation Notes

The example must use only seqlane-core authoring exports. Documentation must
state that Flow aliases are source-only and that repeat bodies are bounded.
It must not expose runtime-engine, executor, or provider details.

## Acceptance Criteria

**Scenario:** _The built-in example uses Flow DSL_

- **Given:** The built-in example workflow
- **When:** Its Plan builds
- **Then:** It matches the prior task-only Plan and contract tests pass

**Scenario:** _Public guidance remains executor-neutral_

- **Given:** A reader opens core or runtime authoring guidance
- **When:** The reader finds Flow DSL and repeat examples
- **Then:** The guidance contains no runtime-engine or executor authoring detail

**Scenario:** _The delivery gate passes_

- **Given:** The completed spec.fluent-seqlane-flow-dsl implementation
- **When:** Repository verification runs
- **Then:** install, typecheck, test, lint, build, formatting, Nx sync, and
  diff checks pass

## Source and current owners

- [adr.fluent-seqlane-flow-dsl — Fluent Seqlane Flow DSL](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.fluent-seqlane-flow-dsl — Fluent Flow DSL and Conditioned Repeat](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [adr.executor-neutral-workflow-authoring — Executor-Neutral Workflow Authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)

## Traceability

- [spec.fluent-seqlane-flow-dsl](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
