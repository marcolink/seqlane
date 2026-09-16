---
id: task.standalone-workflow-loading
title: Load Standalone Workflow Entrypoints
status: planned
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.standalone-cli-runs
supersedes: []
---

# Load Standalone Workflow Entrypoints

## Objective

Implement reusable preparation for explicit file and package workflows. Resolve
packages from the caller project. Support the specified TypeScript configuration,
normal imports, authored exports, JSON input sources, and execution workspace.

## Upstream requirements

- [requirement-explicit-entrypoint](../specs/2026-09-16-standalone-cli-runs.md#requirement-explicit-entrypoint)
- [requirement-module-resolution](../specs/2026-09-16-standalone-cli-runs.md#requirement-module-resolution)
- [requirement-typescript-loading](../specs/2026-09-16-standalone-cli-runs.md#requirement-typescript-loading)
- [requirement-workflow-export](../specs/2026-09-16-standalone-cli-runs.md#requirement-workflow-export)
- [requirement-input-workspace-environment](../specs/2026-09-16-standalone-cli-runs.md#requirement-input-workspace-environment)

## Dependencies

None. This is the first implementation task.

## Scope

- Reference parsing and ESM package resolution.
- Project-aware TypeScript loading without persistent build output or cache.
- Authored export validation and reusable input/workspace preparation.
- External-project, imports, malformed-input, and resolution tests.

## Out of scope

- Hosted app/catalog redesign, persistence, and permission policy.
- Unrelated runtime or terminal refactoring.
- Earlier or later delivery steps beyond the integration seams needed here.

## Implementation plan

1. Map the current reference, workflow loader, and input preparation seams.
2. Implement explicit module resolution without changing hosted catalog behavior.
3. Reuse available transpilation tools and check any added dependency first.
4. Add authored-only loading for standalone use; preserve hosted contracts.
5. Add reusable input/workspace preparation for the later CLI cutover.
6. Prove behavior with scoped tests and update nearby developer documentation.

## Affected areas

The CLI, private runtime, and adapter modules named by the parent deliverable.
Keep edits limited to the scope above and corresponding tests/documentation.

## Verification

Run the test-mapping check before focused tests. Verify the linked requirements
through observable tests and the specification's verification matrix.
Run the repository install, typecheck, test, lint, build, format, Nx sync, and
Git whitespace gates. Preserve hosted behavior during this intermediate step.

## Completion criteria

- Linked requirements pass focused verification for this delivery step.
- Existing command behavior remains coherent until the final cutover.
- Required repository checks pass and review findings are resolved.
- Parent and child task outcomes record evidence separately from target-branch delivery.

## Outcome

Not implemented. A fresh Terra implementation agent delivers this task under
orchestrator review and quality gates. Commit this task before starting its successor.

## Delivery state

Planned. No target-branch delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
