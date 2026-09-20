---
id: task.git-diff-summary-example
title: Add Git Diff Summary Token Comparison Example
status: completed
owners:
  - core
created: 2026-09-20
updated: 2026-09-20
upstream:
  - spec.mastra-backed-seqlane-workflows
  - spec.local-mechanical-tasks
supersedes: []
---

# Add Git Diff Summary Token Comparison Example

## Objective

Add a runnable workflow example that compares one direct agent task with a
workflow that collects deterministic Git evidence before its agent task.

## Upstream requirements

- Use the public `createFlow(...).task(...).output(...).define()` API.
- Keep independent runnable nodes eligible for concurrent execution.
- Use direct executable-plus-argv shell tasks without shell parsing.
- Keep deterministic shell work outside the agent loop and model-token usage.

## Scope

- Add a `git-diff-summary-example` workflow directory.
- Run a direct agent lane and an evidence lane in parallel.
- Make both agent lanes return the same typed diff-summary shape.
- Add focused Plan, nested-workflow, and shell-argv coverage.
- Document the run command and per-agent token comparison.

## Out of scope

- Changes to runtime scheduling or token accounting.
- A new Git helper API or public workflow control-flow node.
- Branch checkout, fetch, push, or other repository mutation.
- A model task that merges or judges the two reports.

## Implementation plan

1. Add the failing workflow topology and shell-boundary test.
2. Add the parent workflow and nested evidence lane.
3. Add the workflow README and repository workflow index entry.
4. Run focused tests, type/build checks, documentation validation, and a local
   CI-mode run when an adapter is configured.

## Affected areas

- `workflows/git-diff-summary-example/`
- `workflows/README.md`
- `apps/cli/src/git-diff-summary-example.spec.ts`

## Verification

- Run `pnpm test:mapping`.
- Run the focused CLI test and CLI build.
- Inspect the generated Plan with `--dry`.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run formatting and `git diff --check`.

## Completion criteria

- The two parent lanes have no dependency on each other.
- The evidence lane orders shell collection before agent summarization.
- Both agent tasks use the same model, instructions, and output schema.
- Git input remains argv-bound and read-only.
- The README explains how to compare per-agent token usage.

## Outcome

Added the `git-diff-summary-example` workflow. Its parent runs a direct agent
task and a nested evidence lane without a dependency between them. The nested
lane runs a direct-argv Git diff task before its agent task. Both agent tasks
share the same model, instructions, and output schema.

Checks passed:

- focused workflow test: 3 tests passed;
- full CLI test suite: 161 tests passed;
- `pnpm test:mapping`;
- CLI TypeScript build;
- `pnpm docs:index`;
- `pnpm docs:validate`;
- formatting and `git diff --check`.

The real OpenCode smoke run verified startup, parallel admission, and shell
execution, but both provider requests returned HTTP 401, so token usage and
agent output quality remain unverified.

## Delivery state

Implemented in the current worktree. Not committed or merged, so this does not
establish delivery on the target branch.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
