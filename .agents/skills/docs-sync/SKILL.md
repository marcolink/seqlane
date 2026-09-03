---
name: docs-sync
description: Review implementation changes like a doc-sync guard and keep nearby documentation aligned. Use before commits, before opening PRs, or after changing code, contracts, config, commands, setup, behavior, or developer workflow near a `README.md`, `AGENTS.md`, runbook, or similar doc.
---

# Docs Sync

Use this skill as a lightweight doc-drift check after meaningful repo changes.

## Goal

For each meaningful change, either:

- update the nearest relevant docs, or
- state briefly why no doc update is needed

## Check Changed Files First

Prefer staged changes when present:

```bash
git diff --name-only --cached
```

If nothing is staged, inspect working tree changes, including untracked files:

```bash
git status --short
git diff --name-only
```

If the working tree is clean, inspect the latest committed change:

```bash
git show --name-only --format= HEAD
```

Focus on code, contracts, config, scripts, tests, generated artifacts, and agent-facing guidance that can change how people or agents use the repo.

## Find The Nearest Relevant Docs

Read only the closest relevant docs first. Avoid broad doc sweeps unless the change clearly crosses package, app, or architecture boundaries.

Check nearby docs in this order:

1. same-directory `README.md`, `AGENTS.md`, or equivalent local doc
2. nearest parent `README.md` or `AGENTS.md`
3. sibling docs with names like `usage`, `how-to`, `runbook`, `operations`, `architecture`, `design`, or `contributing`
4. local `docs/` content for the changed area
5. root `README.md` only when the change affects workspace-level setup, navigation, or shared developer workflow

When the task needs more concrete mapping cues, read [references/doc-sync-heuristics.md](references/doc-sync-heuristics.md).

## Decision Records Are Historical

ADR files or decision records with status `accepted` or `implemented` are historical records.

For accepted or implemented ADRs:

- read them for context
- report drift or contradictions
- suggest a new ADR, superseding ADR, or non-ADR doc update
- do not edit the historical ADR as part of routine doc-sync work

Only edit ADRs when the user explicitly asks for ADR lifecycle work.

## When Docs Usually Need Updates

Update docs when changes affect:

- public API shape or contract behavior
- request or response payloads
- commands, flags, env vars, ports, setup, or local workflows
- feature flags, auth, permissions, or runtime assumptions
- file locations, entrypoints, package layout, or repo navigation readers rely on
- platform boundaries, architecture, service ownership, or data or messaging flow
- important defaults, constraints, edge cases, or failure modes
- examples, snippets, runbooks, or copy-paste workflows
- agent-facing instructions such as `AGENTS.md`, local skills, or automation guidance

## When Docs Often Do Not Need Updates

Usually skip doc edits for:

- refactors with no behavior change
- internal renames invisible to readers
- formatting-only or type-only cleanup
- test-only changes that do not alter supported behavior
- dead-code removal with no doc mention

When skipping docs, end with one short reason.

## Update Style

- Prefer editing existing docs over creating new docs.
- Create a new doc only when no relevant doc exists and the change clearly needs one. For a new ADR, suggest it instead of creating it directly, and hand off to the dedicated ADR-authoring skill only when the user explicitly asks for ADR lifecycle work.
- Keep edits minimal, concrete, and local to the current change.
- Follow the target repo's existing doc structure, naming, and tone.
- Update commands, paths, defaults, and examples together.
- If nearby docs are stale in unrelated ways, fix only the parts touched by the current change unless the user asks for broader cleanup.

## Output Expectation

End with a terse doc-sync result:

- `docs updated: <paths>`
- or `no doc change needed: <reason>`

Good short reasons include:

- `internal refactor only; local docs unchanged`
- `test-only change; no supported behavior changed`
- `format/type cleanup only; no doc-visible impact`
