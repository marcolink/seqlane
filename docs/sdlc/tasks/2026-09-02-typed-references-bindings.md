---
id: task.typed-references-bindings
title: Preserve typed references and bindings
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-plan-ir-typed-dataflow
supersedes: []
---

# Preserve typed references and bindings

> Migrated from implementation story `TS-003-01`.

## Use Case

**As a** Seqlane author, **I want to** pass task output and workflow input references into typed task input, **so that** incorrect wiring fails during TypeScript compilation.

## Scope

- Implement serializable `ValueRef<T>` values with type-preserving nested property access.
- Define recursive `InputBinding<T>` types for literals, nested structures, and compatible references.
- Provide a typed workflow-input root reference.
- Add compile-time type specifications and focused runtime serialization tests.

## Out of Scope

- Creating task nodes or deriving dependencies.
- Runtime execution changes.
- Branch, loop, array-mapping, or expression APIs.

## Implementation Notes

Nested access such as `result.output.files` must produce `ValueRef<string[]>` when `files` is `string[]`. Authoring helpers may use a Proxy internally, but only its plain `{ type, invocationId, path }` data is present in a Plan. Literal and reference bindings must retain existing JSON-like binding support.

## Acceptance Criteria

**Scenario:** *Nested output references retain their exact type*
- **Given:** A task output schema has `files: string[]`
- **When:** An author accesses `result.output.files`
- **Then:** TypeScript treats the value as `ValueRef<string[]>`

**Scenario:** *Incompatible wiring is rejected statically*
- **Given:** A task input requires `string[]`
- **When:** An author binds an incompatible reference or literal
- **Then:** The type specification fails without casts or manual generic parameters

**Scenario:** *References serialize as Seqlane data*
- **Given:** A reference is used in a binding
- **When:** The binding is cloned or serialized
- **Then:** It contains only `type`, `invocationId`, and `path` data and no Proxy/runtime implementation state

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Use a Seqlane-Owned Plan IR with Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.seqlane-plan-ir-typed-dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
