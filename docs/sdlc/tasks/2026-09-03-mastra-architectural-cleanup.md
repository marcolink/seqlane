---
id: task.mastra-architectural-cleanup
title: Remove Superseded Runtime Architecture
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-05
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Remove Superseded Runtime Architecture

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-community-studio](./2026-09-03-mastra-community-studio.md)

## Delivery

- Stack order: 12
- Branch: `mastra-12-architectural-cleanup`
- Pull request base: `mastra-11-community-studio`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Remove remaining Effect orchestration, fallbacks, bridges, dead exports, tests, dependencies, configuration, docs, packages, and projects.
- Search for stale architecture language and forbidden imports.
- Reconcile canonical SDLC documents with the implemented architecture.

## Out of scope

- New product capabilities.
- Unrelated refactors.

## Implementation plan

1. Build a deletion ledger from surviving callers.
2. Delete every unowned migration bridge and obsolete artifact.
3. Run architecture and full-repository gates.

## Affected areas

- repository-wide runtime and documentation cleanup

## Verification

- No old runtime or unexplained bridge remains.
- No `/ee/` import exists.
- The full repository gate passes.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

The repository contains one runtime authority and the migration ledger has no unexplained remainder.

## Outcome

Mastra is now the only production workflow runtime. The superseded Effect
dependency and interruption adapter were removed. Plan preparation now uses
`PlanCompiler`, and the Mastra runner consumes its prepared execution context
directly. The `legacy` execution bridge was removed from the Mastra execution
result. The Mastra path creates only a prepared execution context. It does not
create a native sequential program.

The remaining in-process workflow test harness uses native Promise dependency
execution. It keeps the existing cancellation guarantee by waiting for active
executor work to settle before it reports cancellation. No Effect package,
Effect import, fallback runtime, or unexplained bridge remains in the runtime
package.

Repository searches confirmed that Mastra types remain private, no `/ee/` import
is present, and the Renovate workflow remains outside this migration as the
independent deliverable documented by the delivery plan.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-community-studio](./2026-09-03-mastra-community-studio.md)
- [PR #26](https://github.com/marcolink/seqlane/pull/26)
