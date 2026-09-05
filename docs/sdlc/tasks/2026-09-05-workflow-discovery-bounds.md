---
id: task.workflow-discovery-bounds
title: Bound Workflow Discovery
status: planned
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Bound Workflow Discovery

## Objective

Make workflow discovery predictable for large or untrusted local workspaces.

## Dependencies

- [task.mastra-architectural-cleanup](./2026-09-03-mastra-architectural-cleanup.md)

## Delivery

- Stack order: 13
- Branch: `mastra-13-workflow-discovery-bounds`
- Pull request base: `mastra-operational-contracts`
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

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [adr.repository-user-workflow-discovery-and-composition](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
