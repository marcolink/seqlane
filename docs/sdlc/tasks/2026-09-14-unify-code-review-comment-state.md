---
id: task.unify-code-review-comment-state
title: Unify Code Review Comment State and Cost Projection
status: planned
owners:
  - core
created: 2026-09-14
updated: 2026-09-24
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
`requirement-cost-projection`, `requirement-size-warning`, and
`requirement-comment-index` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).

## Scope

- Define one strict v5 state schema for the scope checkpoint, findings,
  artifact references, publication identity, cost aggregate,
  and period start. If a conflicting v5 state has shipped, use a new version.
- Replace the collapsed machine-data section and visible JSON metrics ledger
  with one bounded base64/gzip HTML comment block.
- Implement the bounded canonical codec and streaming decoder from the spec.
- Render the visible report solely from validated state. Show known overall
  and last published run cost; mark missing provider cost and new-period start.
- Define the typed publication operation in hidden state. Hash a deterministic
  digest-free render and verify the operation and exact body on readback.
- Redact secret-like values and encode untrusted text and links before
  rendering the projection or retaining bounded artifact data.
- Deduplicate GitHub run ID and attempt after recent-run compaction without
  dropping cumulative cost or incompleteness.
- Implement the specified warning and hard-limit behavior without moving the
  prior checkpoint or hiding compaction and omissions.
- Classify legacy states and malformed current states without silently
  migrating a visible ledger into the new cost period.
- Add the typed authority index and resumable duplicate-reconciliation state.
- Implement the empty revision-0 baseline for initial creation and authorized
  legacy replacement.

## Out of scope

- Artifact transport and cleanup.
- Publication queue and GitHub write orchestration.
- Changes to finding identity or incremental scope selection.

## Implementation plan

1. Define the Zod state, empty baseline, and canonical codec. Bound input,
   decompression, and marker parsing; preserve identity checks.
2. Move mechanically derived cost into the state aggregate. Keep detailed
   metrics available to the artifact task without rendering their JSON.
3. Render the projection and hidden block from one state value. Reserve
   warning space before measuring and enforce both hard caps.
4. Add bounded authority-index lookup and duplicate reconciliation. Update
   migration, docs, and focused compatibility tests.

## Affected areas

- `libs/action-code-review/src/workflows/review-history.ts`
- `libs/action-code-review/src/publication-state.ts`
- `libs/action-code-review/src/publication-rendering.ts`
- `libs/action-code-review/src/publication-fitting.ts`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused codec, migration, projection, cost, malformed
  input, operation-digest, hostile Markdown/HTML/URL, and size-bound tests.
  Cover the exact boundaries and lookup states required by the specification.
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
