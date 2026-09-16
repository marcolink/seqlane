---
id: task.standalone-workflow-loading
title: Load Standalone Workflow Entrypoints
status: completed
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

Implemented explicit file and caller-relative package loading, authored export
validation, bounded JSON input, and independent workspace preparation. Local
TypeScript imports retain ESM semantics and loader hooks until disposal.
The CLI now declares `tsx` and `get-tsconfig` dependencies. Snyk checks found
no known direct vulnerabilities in the selected versions.

An isolated Jiti 2.7.0 comparison passed ordinary loading and cache checks.
It repeated import-time side effects when a native module threw, and changed
circular-import behavior from an ESM reference error to an invalid value.
Keep `tsx` to preserve the specified ESM execution semantics.

Fresh-process tests cover unconfigured TypeScript, inherited aliases, imports
outside the entrypoint directory, runtime imports, source assets, and absence
of a transpilation cache. Package tests cover ESM conditions and named subpaths.
Input tests cover invalid JSON, UTF-8, size limits, files, and explicit stdin.

The full install, typecheck, test, lint, build, format, Nx sync, and whitespace
gates passed. Process-lifecycle tests required execution outside the sandbox.
Two existing gate defects were repaired: the OpenCode result fixture omitted
`structured`, and the root TypeScript references omitted the Codex package.
Static review found no changed loader call signature. The churn warning reflects
the deliberate extraction of shared authored-workflow validation.

## Delivery state

Verified on `feat/standalone-cli-runs`. The public command cutover remains in
the fourth task. No delivery to the default branch is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
