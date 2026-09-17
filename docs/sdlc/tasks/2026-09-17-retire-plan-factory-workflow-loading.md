---
id: task.retire-plan-factory-workflow-loading
title: Retire Plan Factory Workflow Loading
status: completed
owners:
  - core
created: 2026-09-17
updated: 2026-09-17
upstream:
  - spec.standalone-cli-runs
supersedes: []
---

# Retire Plan Factory Workflow Loading

## Objective

Make an authored Seqlane workflow the only module-loader entrypoint. Remove raw
Plan and input-dependent Plan-factory compatibility from the shared loader.

## Upstream requirements

- [requirement-workflow-export](../specs/2026-09-16-standalone-cli-runs.md#requirement-workflow-export)

## Scope

- Replace the loader result with one authored-workflow contract.
- Compile and validate authored exports through one shared helper.
- Migrate runner, hosted CLI, standalone CLI, and tests to that contract.
- Reject raw Plans and Plan factories with an actionable error.

## Out of scope

- Removing the Plan IR or internal Plan fixtures.
- Changing workflow execution input semantics.
- Adding migration shims or retaining legacy module-export forms.

## Implementation plan

1. Add failing loader tests for raw Plan and factory exports.
2. Remove legacy loader branches and expose one compiled authored-workflow result.
3. Migrate all loader consumers to the direct result fields.
4. Run focused loader, runner, hosted CLI, and standalone CLI verification.

## Affected areas

- `libs/runtime` workflow loading and runner setup.
- `apps/cli` standalone and operational workflow loading.
- Loader and command regression tests.

## Verification

Run the test-mapping check, focused affected tests, package typechecks, and
documentation validation. Raw Plan and Plan-factory module exports must fail.

## Completion criteria

- Module exports have one authored-workflow contract.
- Consumers need no optional registry or legacy result branches.
- The authored definition, compiled Plan, and registries remain available from
  one stable loader result.

## Outcome

Removed raw Plan and Plan-factory module loading. The shared loader now
returns one flattened authored-workflow result with its compiled Plan and
registries. Runner and CLI consumers use that result directly; the plan command
no longer accepts input used only by Plan factories.

`pnpm test:mapping`, `nx build runtime,cli`, `nx test runtime`, and `nx test
cli` passed. The affected lint target remains blocked by an existing
`no-unsafe-finally` error in `libs/runtime/src/runtime/mastra/mastra-execution.ts`.

## Delivery state

Implementation is tracked on a stacked pull request. No default-branch
delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
