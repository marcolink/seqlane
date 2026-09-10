---
id: task.audit-sdlc-delivery-state
title: Audit SDLC Delivery State
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.sdlc-documentation-system
supersedes: []
---

# Audit SDLC Delivery State

## Objective

Audit canonical SDLC documents against the current target branch. Correct
stale lifecycle states, delivery claims, dates, links, and documentation
guidance without changing product or runtime implementation.

## Upstream requirements

Apply [spec.sdlc-documentation-system](../specs/2026-09-03-sdlc-documentation-system.md),
including its authority, traceability, and delivery-state requirements.

## Scope

- Compare document claims with current target-branch source, tests,
  configuration, and reachable Git history.
- Correct ADR, spec, and task lifecycle states that conflict with that evidence.
- Record delivery gaps when a local, disconnected, or unreachable change does
  not establish current delivery.
- Clarify that lifecycle statuses and indexes are metadata, not a single source
  of truth for implementation delivery.
- Correct stale `updated` dates and traceability wording.
- Keep retired specifications with clear status notes when no replacement exists.

## Out of scope

- Runtime, workflow, Action, package, test, or lockfile implementation changes.
- Changes to product requirements or architecture decisions.
- Creating a replacement for retired functionality without an approved design.

## Implementation plan

1. Read the SDLC instructions, indexes, relevant documents, and target-branch
   implementation evidence.
2. Record the evidence hierarchy in the SDLC guidance and documentation spec.
3. Correct the identified ADR, spec, and task states and delivery notes.
4. Update the affected skills and templates so new documents preserve the same
   state distinction.
5. Run the documentation index, validator, documentation tests, formatting,
   and Git diff checks.

## Affected areas

- `AGENTS.md`
- `docs/sdlc/AGENTS.md`
- `docs/sdlc/index.md`
- `docs/sdlc/adrs`
- `docs/sdlc/specs`
- `docs/sdlc/tasks`
- `.agents/skills/sdlc-author/SKILL.md`
- `.agents/skills/sdlc-sync/SKILL.md`
- `.agents/skills/docs-sync/SKILL.md`
- `.agents/skills/seqlane-adr-delivery/SKILL.md`
- `docs/sdlc/templates`

## Verification

Run:

```text
pnpm docs:index
pnpm docs:validate
pnpm docs:test
pnpm format:check
git diff --check
```

Inspect the generated indexes and the final diff for stale statuses, broken
links, unsupported ADR states, and claims that use task or spec metadata as
delivery proof.

## Completion criteria

- The authority and delivery-evidence rules are explicit at the root and SDLC
  documentation levels.
- The documentation-system specification defines the delivery evidence
  hierarchy.
- The identified ADR, spec, and task states and dates match the audit result.
- Delivery gaps and hosted-run limitations are recorded without overclaiming.
- Skills and templates keep ADR lifecycle state separate from implementation
  delivery state.
- The retired built-in workflow ADR and specification record their historical
  removal.
- Documentation indexes, validation, documentation tests, and diff checks pass.
  The Outcome records any unavailable repository-wide formatting gate.

## Outcome

The document-state audit and the required documentation corrections are
complete in this working tree. The completed status records the task's
implementation and document revision. It does not claim default-branch
delivery.

`pnpm docs:index`, `pnpm docs:validate`, `pnpm docs:test`, and
`git diff --check` pass. `pnpm format:check` cannot run in this checkout
because `node_modules` is absent and the Nx executable is unavailable. This
environment limitation is not reported as a formatting pass.

## Delivery state

This working-tree implementation still needs merge to be delivered. Current
default-branch delivery is not established until the documentation changes
have a reachable commit and the target branch contains the resulting files.

## Traceability

- Contract: [spec.sdlc-documentation-system](../specs/2026-09-03-sdlc-documentation-system.md)
- Guidance: [SDLC index](../index.md) and [SDLC agent instructions](../AGENTS.md)
