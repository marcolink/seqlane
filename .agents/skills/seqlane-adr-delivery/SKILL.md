---
name: seqlane-adr-delivery
description: Deliver a Seqlane ADR from technical specification and implementation stories through verified, per-story commits. Use when asked to implement an ADR, generate its TS/stories, or run the ADR-to-story delivery loop with fresh subagents.
---

# Seqlane ADR Delivery

Use this workflow for a named Seqlane ADR. Work sequentially; never begin another story before the current story is accepted, verified, and committed.

## 1. Establish Context

1. Read `AGENTS.md`, the target ADR, its TS document, its story directory, relevant RFC/MVP documents, and `git status`.
2. Read the affected source, tests, package manifests, Nx configuration, and nearby documentation before planning edits.
3. Preserve unrelated staged or unstaged work. Never reset, checkout, stash, or reformat unrelated files.
4. Work on the requested ADR branch. Create one only when asked or when the task explicitly requires a dedicated ADR branch. Do not merge to `main` unless explicitly asked.

## 2. Make the Delivery Backlog

If the ADR lacks a technical specification, create `docs/TS-<ADR>-<slug>.md` from the ADR's accepted decisions, scope, invariants, contracts, and MVP exclusions. If the ADR or authoritative product docs are ambiguous, ask before inventing a product decision.

If the TS lacks stories, create `docs/stories/TS-<ADR>/` with a `README.md` index and one `TS-<ADR>-NN-<slug>.md` file per story:

- start with a bootstrap/dependency story when package or tooling setup is required;
- use `TS-<ADR>-00`, `TS-<ADR>-01`, and so on;
- give every story a user outcome, scope, out-of-scope items, implementation notes, and testable Gherkin acceptance criteria;
- order stories by dependency and keep each independently committable.
- for ADR-001 through ADR-007, include RFC-001 in every story's `Source` section and do not cite RFC-002 anywhere in a story.

The index contains only ordering and links. Never put multiple story definitions in one file.

Read the TS and story docs again after writing them. Do not start implementation until their acceptance criteria are concrete.

## 3. Deliver One Story

For the next incomplete story:

1. Make a concise implementation plan: intended files, dependency/config changes, test approach, acceptance-criterion mapping, and risks.
2. Start a **fresh high-reasoning implementation subagent session**. Never reuse a prior session; use Luna-high when available or explicitly requested.
3. Give the subagent the story file, plan, `AGENTS.md`, ADR, TS, story index, relevant RFC/MVP/earlier-TS docs, current source/tests, and current repository status. Explicitly require it to read and understand them before editing.
4. Require the subagent to keep scope to the story, preserve existing work, avoid commit/stage/reset/stash, update tests and docs when behavior changes, and report changed paths plus verification.
5. Poll the subagent with bounded waits (normally 30 seconds; never rely only on a completion notification). Report status as `story · agent state · next action` when it changes.
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
9. Run a docs-sync review. Update mutable docs for changed commands, contracts, config, behavior, or package layout. Do not routinely rewrite accepted or implemented ADRs.
10. Commit only the completed story on the ADR branch. Use one clear conventional commit per story; do not skip hooks. Confirm a clean working tree before moving on.

## 4. Complete the ADR

Repeat Section 3 for every remaining story. At completion, report:

- ADR and story IDs committed;
- acceptance criteria and verification evidence;
- branch and clean/dirty status;
- deferred work or explicit gaps.

Do not claim completion from subagent notification alone. Completion requires reviewed changes, confirmed acceptance criteria, and a passing full verification gate.
