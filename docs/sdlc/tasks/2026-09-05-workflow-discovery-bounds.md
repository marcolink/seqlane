---
id: task.workflow-discovery-bounds
title: Bound Workflow Discovery
status: planned
owners:
  - core
created: 2026-09-05
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Bound Workflow Discovery

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Make workflow discovery predictable for large or untrusted local workspaces.

## Current replacement

This later task owns replacement work. It was not an original prerequisite.

- [task.effect-v4-complete-removal-and-release](./2026-10-21-effect-v4-complete-removal-and-release.md)

## Delivery

- Stack order: 13
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-workflow-discovery-bounds`
- `requirement-public-boundary`

## Scope

- Define one Zod-validated discovery-limits contract with bounded defaults.
- Enforce configured root containment, recursion depth, scanned-file count,
  discovered-workflow count, and startup-time limits.
- Do not follow a symbolic link that resolves outside its declared root.
- Report typed containment and limit failures before workflow registration.
- Define deterministic handling for duplicate qualified workflow names.

## Out of scope

- Workflow descriptors, name resolution, or CLI list and plan commands.
- Remote catalogs, package registries, or network discovery.
- Changing the public workflow-authoring API.

## Implementation plan

1. Define the limits schema and its stable failure categories.
2. Build root-contained traversal with symlink checks and budgets.
3. Add deterministic duplicate handling.
4. Add tests for every exceeded budget, symlink escape, and duplicate.

## Affected areas

- private workflow-loading and discovery modules
- discovery contract tests
- workflow author documentation

## Verification

- Traversal never visits a path outside a declared root.
- Every configured budget produces a typed failure before registration.
- Duplicate qualified names have deterministic diagnostics.
- Discovery makes no executor or model call.

## Completion criteria

Workflow discovery remains bounded and root-contained before any workflow is
loaded, registered, or executed.

## Outcome

Not started.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [adr.repository-user-workflow-discovery-and-composition](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
