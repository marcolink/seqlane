---
id: task.consolidate-pull-request-review-run-metrics
title: Consolidate Pull Request Review Run Metrics
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Consolidate Pull Request Review Run Metrics

## Objective

Replace separate per-run audit comments with one strict, human-readable run
metrics ledger in the authoritative pull-request review comment.

## Upstream requirements

Implement
[requirement-run-status-and-metrics](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-run-status-and-metrics).

## Scope

- Define and strictly validate the visible run metrics ledger.
- Read an invalid, missing, unsupported, or legacy ledger as an empty ledger.
- Preserve valid review state, findings, and lifecycle data when the ledger is
  discarded.
- Append and deduplicate runs by GitHub workflow run ID and attempt.
- Render the canonical ledger as one marked, plain JSON object.
- Derive all displayed cost and run-count values from the ledger's `runs`.
- Remove workflow publication and retrieval of per-run audit comments.
- Reject publication if the final comment, including the ledger, exceeds its
  existing byte limit.
- Update focused tests and the nearby review documentation.

## Out of scope

- Migrating or recovering existing run metrics from v3 state or audit comments.
- Changing task cost, token, model, provider, or duration calculation.
- Changing review findings, lifecycle semantics, authorization, or concurrency.
- Changing the final comment byte limit or adding a new external metrics store.

## Implementation plan

1. Add an owning strict schema and parser for the marked metrics ledger.
2. Carry a valid prior ledger through review-context output; otherwise use an
   empty ledger without invalidating the review state.
3. Replace audit-comment collection and posting in the publisher with one
   append-or-deduplicate ledger update.
4. Render the ledger directly and derive displayed totals from its `runs`.
5. Remove obsolete run audit state fields and audit-comment handling only where
   they are no longer needed by the new contract.
6. Add focused regression coverage for missing, malformed, legacy, duplicate,
   and consecutive-run ledgers, plus rendered derived totals.
7. Update the review example documentation and run the scoped checks.

## Affected areas

- `examples/pr-code-review.ts`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/specs`
- `docs/sdlc/tasks`

## Verification

- Run `pnpm run test:mapping` before focused tests.
- Run the focused `seqlane-cli` review workflow tests.
- Validate the workflow YAML and exercise the ledger jq program with
  representative valid and invalid comments.
- Run `pnpm docs:index`, `pnpm docs:validate`, formatting, and
  `git diff --check`.
- Dispatch the trusted workflow against an open pull request and confirm that
  one authoritative comment contains the visible ledger with consecutive runs.

## Completion criteria

- One authoritative comment contains one marked JSON ledger with all retained
  metrics runs and their GitHub run identities.
- No per-run audit comments are created or read.
- Totals shown to reviewers are derived from the ledger at render time.
- An invalid or legacy ledger starts fresh without losing valid review state.
- A duplicate run ID and attempt does not add a second entry.
- An oversized final comment fails safely without dropping entries.

## Outcome

Completed. The review context now parses one strict, marked metrics ledger
independently from review state and starts an empty ledger for malformed,
unsupported, legacy, or missing metrics data. The authoritative publisher
appends and deduplicates ledger entries by GitHub workflow run ID and attempt,
derives displayed count and cost values from `runs`, renders the ledger as one
human-readable JSON object, and no longer creates or reads per-run audit
comments. Legacy metrics are not migrated, while valid review state remains
usable. Focused regression coverage and the review example documentation were
updated.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Replaced delivery: [task.preserve-pull-request-review-run-history](./2026-09-05-preserve-pull-request-review-run-history.md)
