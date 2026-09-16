---
id: task.centralize-workflow-directories
title: Centralize Portable Workflow Directories
status: completed
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.mastra-backed-seqlane-workflows
  - spec.direct-runtime-code-review-action
supersedes: []
---

# Centralize Portable Workflow Directories

## Objective

Place repository portable workflows in `workflows/<name>/workflow.ts`. Add a
workflow to the Nx project graph only when it owns a build, test, lint, or
smoke-check target; do not change CLI directory invocation.

## Scope

- Move runnable examples and portable read-context/code-review graphs.
- Keep fixtures test-only.
- Keep consumer environment adapters in their consumers.
- Define local conventions in `workflows/AGENTS.md`.
- Give each workflow a local README that states its executable contract.
- Include workflow sources and workflow graph tests in existing validation.

## Out of scope

- npm publishing.
- `seqlane run <directory>` support.
- New workflow unit tests.

## Verification

- Run test-mapping, workflow typechecks, moved regression coverage, and
  focused CLI workflow coverage.

## Outcome

Portable workflows now have directory entrypoints and targeted Nx ownership.
Each workflow documents its local contract. Read-context library regressions
remain with the library, while its graph has focused workflow coverage.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
