---
name: seqlane-adr-delivery
description: Deliver a Seqlane ADR from technical specification and implementation tasks through verified, per-task commits. Use when asked to implement an ADR, create its spec/tasks, or run the ADR-to-task delivery loop with fresh subagents.
---

# Seqlane ADR Delivery

Use this workflow for a named Seqlane ADR. Read `docs/sdlc/AGENTS.md` first. Work sequentially; never begin another task before the current task is accepted, verified, and committed.

## 1. Establish Context

1. Read `AGENTS.md`, the target ADR, its active spec, its task entries, relevant RFC/PRD documents, and `git status`.
2. Separate ADR lifecycle state from implementation delivery state. An accepted
   ADR, active spec, or completed task does not prove delivery on the current
   target branch.
3. Run `sdlc-impact` before implementation work and record its documentation impact assessment.
4. Read the affected source, tests, package manifests, Nx configuration, and nearby documentation before planning edits.
5. Preserve unrelated staged or unstaged work. Never reset, checkout, stash, or reformat unrelated files.
6. Work on the requested ADR branch. Create one only when asked or when the task explicitly requires a dedicated ADR branch. Do not merge to `main` unless explicitly asked.

## 2. Make the Delivery Backlog

If the ADR lacks a technical specification, use `sdlc-author` to create a
`docs/sdlc/specs/YYYY-MM-DD-<slug>.md` document with a stable
`spec.<slug>` metadata ID. Base it on the ADR's accepted decisions, scope,
invariants, contracts, and PRD exclusions. If the ADR or authoritative product
docs are ambiguous, ask before inventing a product decision.

If the spec lacks tasks, use `sdlc-author` to create one
`docs/sdlc/tasks/YYYY-MM-DD-<slug>.md` file per task:

- start with a bootstrap/dependency task when package or tooling setup is required;
- assign each task a stable `task.<slug>` metadata ID;
- give every task an objective, scope, out-of-scope items, implementation plan, verification, and completion criteria;
- record task dependencies with stable metadata IDs and Traceability links; treat
  `docs/sdlc/tasks/index.md` as discovery metadata, not execution order;
  keep each task independently committable;
- link each task to its spec in frontmatter and its `Traceability` section.

The type index contains only discovery metadata and links. Never put multiple task definitions in one file.

Read the spec and task documents again after writing them. Run `pnpm docs:index` and `pnpm docs:validate`. Do not start implementation until their acceptance criteria are concrete.

## 3. Deliver One Task

Select the next incomplete task by checking its explicit metadata dependencies
and active spec. Never infer dependency order from task index row order or
filename naming.

1. Make a concise implementation plan: intended files, dependency/config changes, test approach, acceptance-criterion mapping, and risks.
2. Start a **fresh high-reasoning implementation subagent session**. Never reuse a prior session; use Luna-high when available or explicitly requested.
3. Give the subagent the task file, plan, `AGENTS.md`, ADR, spec, task index, relevant RFC/PRD/earlier-spec documents, current source/tests, and current repository status. Explicitly require it to read and understand them before editing.
4. Require the subagent to keep scope to the task, preserve existing work, avoid commit/stage/reset/stash, update tests and docs when behavior changes, and report changed paths plus verification.
5. Poll the subagent with bounded waits (normally 30 seconds; never rely only on a completion notification). Report status as `task · agent state · next action` when it changes.
6. On completion, review the diff against every acceptance criterion. Search for missed call sites and stale docs/contracts.
7. Run the verification gate from the repository root:

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm lint
   pnpm build
   pnpm format:check
   pnpm exec nx sync:check
   git diff --check
   ```

8. If a gate or acceptance criterion fails, start another fresh subagent to make the scoped repair, then rerun the affected gates and the full gate before continuing.
9. Run `sdlc-sync` for canonical SDLC reconciliation. Run `docs-sync` for nearby README, AGENTS.md, command, configuration, or package-layout documentation. Do not routinely rewrite accepted ADRs.
10. Mark the task completed only when its implementation and required checks are represented. Record delivery evidence separately. Run `pnpm docs:index` and `pnpm docs:validate`. Commit only the completed task on the ADR branch. Use one clear conventional commit per task. Do not skip hooks. Confirm a clean working tree before moving on.

## 4. Complete the ADR

Repeat Section 3 for every remaining task. At completion, report:

- ADR, spec, and task IDs committed;
- acceptance criteria and verification evidence;
- current target-branch delivery evidence, or the explicit delivery gap;
- branch and clean/dirty status;
- deferred work or explicit gaps.

Do not claim completion from subagent notification alone. Completion requires reviewed changes, confirmed acceptance criteria, and a passing full verification gate.
