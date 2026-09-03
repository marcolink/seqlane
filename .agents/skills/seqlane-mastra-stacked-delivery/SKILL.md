---
name: seqlane-mastra-stacked-delivery
description: Deliver the Seqlane-to-Mastra migration as dependency-ordered GitHub stacked pull requests based on the mastra integration branch.
---

# Seqlane Mastra Stacked Delivery

Use this skill for any task in
[spec.mastra-runtime-and-operational-integration](../../../docs/sdlc/specs/2026-09-03-mastra-runtime-and-operational-integration.md).

## Stack topology

- `mastra` is the integration base and contains the documentation foundation.
- Never implement a runtime task directly on `mastra`.
- Use the exact branch and pull request base in the task's `Delivery` section.
- Do not use `mastra/<name>`; Git cannot store it beside the `mastra` branch.
- Except for the documentation foundation on `mastra`, one task maps to one
  branch and one pull request.
- Build tasks in dependency order. Do not infer order from filenames or indexes.
- No migration task pull request targets `main` directly.
- Merge completed task pull requests into the stack until all changes reach
  `mastra`. Test the complete migration on `mastra` before its final pull
  request targets `main`.

The expected chain starts as:

```text
main
└── mastra
    └── mastra-01-community-dependencies
        └── mastra-02-runtime-spine
            └── ...
```

## GitHub Stack commands

The repository uses the installed `gh stack` extension.

For the first implementation task:

```sh
git checkout mastra
gh stack init --base mastra mastra-01-community-dependencies
```

For each later task, check out the current stack top and add the task branch:

```sh
gh stack add <branch-from-task-delivery-section>
```

After the primary agent has reviewed, committed, and validated the task:

```sh
gh stack submit --auto
gh stack view
```

New pull requests remain drafts unless the user requests `--open`. Verify every
head/base pair after submission. Use `gh stack sync` after parent merges.
Never merge the stack unless the user explicitly requests it.

## Task execution

1. Read the task, active spec, RFC, PRD, root `AGENTS.md`, and
   `docs/sdlc/AGENTS.md`.
2. Run `sdlc-impact` and inspect the current branch, stack, worktree, source,
   tests, manifests, Nx configuration, and nearby documentation.
3. Start one fresh subagent for the task with exactly:
   - model: `gpt-5.6-luna`
   - reasoning effort: `high`
4. Give the subagent the governing documents, relevant source/tests, current
   status, and task acceptance criteria.
5. Require the subagent to stay within task scope and not stage, commit, push,
   create or edit pull requests, reset, stash, or change unrelated work.
6. The primary agent reviews the diff, verifies every acceptance criterion, and
   searches for missed callers and stale support material.
7. Run focused checks and the full verification gate from the active spec.
8. Use `sdlc-sync`, `docs-sync`, `seqlane-migration`, `mastra`, and
   `architectural-cleanup` where their scopes apply.
9. Mark the task completed, record its outcome, update indexes, and validate
   SDLC documents.
10. The primary agent creates one conventional commit, submits the stack, and
    verifies the pull request topology.

Repairs require a new Luna-high subagent. Never reuse a completed implementation
subagent.

## Commits and pull request copy

- This repository is an independent project. Do not require, invent, or add a
  Jira or other ticket ID to branch names, commits, or pull requests.
- Use concise Conventional Commit subjects and pull request titles without a
  ticket suffix.
- Describe only the change intent, scope, behavior, stack position, and
  verification relevant to reviewers.
- Do not mention the agent, model, automation, GitHub Stack tooling, or any
  other tool that created or submitted the pull request.
- Do not add generated-by, co-authored-by, agent-credit, or “created with” text.

## Stop conditions

Stop and request direction if:

- unrelated work is present;
- a dependency or contract is ambiguous;
- a named branch has unexpected history;
- a pull request has the wrong head or base;
- the diff exceeds task scope;
- a fallback, dual runtime, dual write, unexplained bridge, or `/ee/` import
  appears;
- validation still fails after one scoped repair.

Do not delete branches, force-push, rewrite unrelated history, or merge pull
requests without explicit user authorization.
