---
name: sdlc-sync
description: Reconcile canonical Seqlane SDLC documents with completed implementation and report unresolved traceability drift.
---

# SDLC sync

Run this skill after implementation and before declaring the task complete.

## Compare implementation with the contract

1. Read `docs/sdlc/AGENTS.md`, the linked task, and its active upstream spec.
2. Inspect the implementation diff, tests, configuration, and changed behavior.
3. Compare the result with the spec's requirements, contracts, edge cases, and
   acceptance criteria.
4. Check the upstream links and downstream Traceability links.

Classify each difference:

- implementation matches the active spec;
- intentional contract change;
- accidental implementation drift;
- unresolved documentation drift.

Never rewrite a spec to excuse an accidental implementation deviation. Fix the
implementation or explicitly change the contract through the correct document
type. Use `sdlc-impact` when the change requires a new impact assessment.

## Reconcile documents

- Update the spec only when the implementation intentionally changes its
  contract.
- Update the task status and record the actual outcome in its `Outcome`
  section.
- Add links to relevant commits or pull requests in the task's Outcome or
  Traceability section when available.
- Set `updated` to the current date for changed documents. Preserve `created`
  and the filename date.
- Update type indexes with `pnpm docs:index`.
- Mark replaced documents as `superseded` and add the replacement to
  `supersedes`. Keep superseded documents at their canonical paths.
- Delete an obsolete duplicate only after confirming that its canonical
  content and inbound links are preserved.

Accepted or superseded ADRs are historical records. Do not rewrite them to
match implementation details. Create a replacement ADR when the decision
changes.

## Verification

Run the deterministic SDLC checks:

```sh
pnpm docs:index
pnpm docs:validate
```

Run the repository documentation build when one exists. In this repository,
the index generator and SDLC validator are the documentation build gate.

## Required output

```md
## Documentation sync

- Implementation: matches spec | intentionally changed | drift found
- Task: updated status and outcome
- Spec: unchanged | updated | superseded
- Indexes: updated
- Checks: `pnpm docs:index`, `pnpm docs:validate`

### Resolved drift

List the changes made.

### Unresolved drift

List remaining mismatches. Do not declare completion while required drift
remains unresolved.
```
