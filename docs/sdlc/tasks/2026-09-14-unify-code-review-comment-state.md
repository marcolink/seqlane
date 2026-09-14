---
id: task.unify-code-review-comment-state
title: Unify Code Review Comment State and Cost Projection
status: planned
owners:
  - core
created: 2026-09-14
updated: 2026-09-14
upstream:
  - spec.github-native-review-publication
supersedes: []
---

# Unify Code Review Comment State and Cost Projection

## Objective

Make the hidden, versioned comment state the only source for the review
checkpoint, human report, and published-run cost.

## Upstream requirements

Implement `requirement-comment-authority`, `requirement-hidden-transport`,
`requirement-cost-projection`, and `requirement-size-warning` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).

## Scope

- Define one strict v5 state schema for the scope checkpoint, findings,
  dispositions, artifact references, publication identity, cost aggregate,
  and period start. If a conflicting v5 state has shipped, use a new version.
- Replace the collapsed machine-data section and visible JSON metrics ledger
  with one bounded base64/gzip HTML comment block.
- Render the visible report solely from validated state. Show known overall
  and last published run cost; mark missing provider cost and new-period start.
- Deduplicate GitHub run ID and attempt after recent-run compaction without
  dropping cumulative cost or incompleteness.
- Measure encoded payload characters and entire UTF-8 comment bytes. Warn
  visibly at 80%; fail clearly at the hard limits without moving the prior
  checkpoint. Report every compaction and omission.
- Classify legacy states and malformed current states without silently
  migrating a visible ledger into the new cost period.

## Out of scope

- Artifact transport and cleanup.
- Publication queue and GitHub write orchestration.
- Changes to finding identity or incremental scope selection.

## Implementation plan

1. Define the Zod state and canonical codec. Bound input, decompression, and
   marker parsing; preserve identity checks.
2. Move mechanically derived cost into the state aggregate. Keep detailed
   metrics available to the artifact task without rendering their JSON.
3. Render the projection and hidden block from one state value. Reserve
   warning space before measuring and enforce both hard caps.
4. Update state readers, migration, docs, and focused compatibility tests.

## Affected areas

- `libs/action-code-review/src/workflows/review-history.ts`
- `libs/action-code-review/src/publication-state.ts`
- `libs/action-code-review/src/publication-rendering.ts`
- `libs/action-code-review/src/publication-fitting.ts`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused codec, migration, projection, cost, malformed
  input, and size-bound tests.
- Verify multibyte comment size and a missing-cost run. Run docs validation
  and `git diff --check`.

## Completion criteria

- The next run restores one strict hidden state; visible text cannot alter it.
- Cost and size behavior match every upstream acceptance criterion.
- No visible per-run JSON metrics ledger remains in v5 publication.

## Outcome

Implementation pending.

## Delivery state

Planned. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- Follow-on proposal: [PR #112](https://github.com/marcolink/seqlane/pull/112)
