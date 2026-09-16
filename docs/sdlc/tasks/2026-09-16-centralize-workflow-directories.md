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

Place repository portable workflows in `workflows/<name>/workflow.ts` and add
them to the Nx project graph without changing CLI directory invocation.

## Scope

- Move runnable examples and portable read-context/code-review graphs.
- Keep fixtures test-only.
- Keep consumer environment adapters in their consumers.
- Define local conventions in `workflows/AGENTS.md`.

## Out of scope

- npm publishing.
- `seqlane run <directory>` support.
- New workflow unit tests.

## Verification

- Run test-mapping, workflow typechecks, moved regression coverage, and
  focused CLI workflow coverage.

## Outcome

Portable workflows now have directory entrypoints and Nx ownership. Existing
read-context regression coverage moved with its graph.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
