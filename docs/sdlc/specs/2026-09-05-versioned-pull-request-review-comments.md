---
id: spec.versioned-pull-request-review-comments
title: Versioned Pull Request Review Comments
status: active
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream: []
supersedes: []
---

# Versioned Pull Request Review Comments

## Summary

The pull-request review example publishes one trusted comment for each pull
request. The comment separates the human review from the persisted review
state.

## Goals

- Give reviewers a short and stable human review.
- Preserve bounded lifecycle state between review runs.
- Prevent an old run from replacing a review for a newer head revision.
- Give each finding one stable publisher-owned identifier.
- Preserve human dispositions without treating a claim as verified evidence.

## Non-goals

- Execute pull-request code, tests, builds, scripts, or checks.
- Store patches, credentials, or secret values in the GitHub comment.
- Replace internal ratings, evidence, or observability data.
- Define a public Seqlane package contract.

## Terminology

- **Authoritative comment:** The trusted bot comment that owns the review state.
- **Human projection:** The concise Markdown review that people read.
- **Review state:** The validated machine data that the next review consumes.
- **Comparable predecessor:** A prior reviewed revision that Git identifies as
  an ancestor of the current reviewed revision.
- **Disposition:** An authorized human decision, such as `wont-fix` or
  `downgrade`.

## Requirements

### requirement-trusted-authority

The publisher must read and update comments from the configured bot identity
only. The marker must contain the schema version, pull-request number, and full
reviewed revision.

### requirement-publication-order

The publisher must read the live pull-request state before each write. The
pull request must remain open and eligible. Its head revision must equal the
report revision.

### requirement-state-contract

The authoritative comment must contain exactly one metadata marker and one
bounded state block. A strict Zod schema must validate the decoded state before
use. The state identity must match the metadata identity.

The state must contain these fields:

- schema version;
- pull-request number;
- base and reviewed revisions;
- comparable predecessor revision, when available;
- the next finding index;
- retained findings and lifecycle metadata;
- review limitations;
- bounded run audit metadata.

### requirement-stable-identity

The local finalizer owns final finding identifiers. A new identifier uses the
format `SEQ-PR{number}-{index}` with a three-digit minimum index.

The finalizer must not reuse an index. A retained or reopened finding keeps its
identifier. Review agents can reference prior identifiers but cannot allocate
new final identifiers.

The finalizer must collapse duplicate temporary and legacy identifiers before
it assigns stable identifiers. Legacy deduplication must mark the state as
truncated and add a limitation.

### requirement-lifecycle

Each retained finding has one lifecycle status:

- `new`: the current review detected the finding for the first time;
- `open`: the current review detected an active prior finding;
- `addressed`: an authorized fix claim exists, but verification is incomplete;
- `resolved`: current-head verification found that the problem is absent;
- `reopened`: the current review detected a previously resolved finding;
- `dismissed`: an authorized decision accepts the finding or rejects its
  applicability.

A downgrade changes effective severity. It does not dismiss the finding.

### requirement-fixed-verification

A `/seqlane fixed` command is a claim and sets an unresolved finding to
`addressed`. A separate review task must inspect each claimed fix against the
current head.

The task must return a typed result for each inspected finding. Each result
must contain the finding identifier, head revision, outcome, and bounded
evidence.

Only a `resolved` result for the current head can set the finding to
`resolved` or keep it resolved. A missing, stale, or uncertain result keeps the
finding active. Removing or retargeting the authorizing disposition reopens a
previously resolved finding, even when current-head verification reports that
the original implementation is absent.

An edited comment triggers review only when its current or previous body has a
recognized command. This permits command removal without running reviews for
unrelated comment edits.

Comment collection must preserve recognized command lines even when it bounds
the surrounding comment body. It must retain the latest commands before
optional context when it applies the final comment bound. It must mark history
as truncated if older command lines do not fit. The collector must enforce one
aggregate command-count and text budget across the retained history. Before it
applies that budget, it must retain only the latest command for each finding
and authorization class. The collector must mark each comment that loses a
command to the aggregate budget. Lifecycle reconciliation must preserve a
prior disposition when its authorizing comment has this marker. It must still
reopen the finding when the command was removed or retargeted without
projection loss.

### requirement-human-projection

The human projection must show the verdict, active counts, reviewed revision,
one findings table, and the available `/seqlane` commands. It must show plain
Markdown sections for active Critical and Required findings. Each section must
show the finding ID, severity, area, location, explanation, and resolution.

Severity and lifecycle labels must use the emoji vocabulary from the source
review template.

The projection can omit internal ratings and run evidence. It must show a
deterministic limitation notice when retained evidence or history is
incomplete.

The projection shows at most 20 retained findings and 10 verification entries.
The state block retains the complete bounded state when the projection omits
items.

The projection must neutralize model-controlled text before Markdown renders
it. Active Critical and Required findings must remain visible before inactive
history when the projection reaches its limit.

### requirement-bounds

The state and human projection must have explicit size and item limits. The
retention policy must keep active blockers before non-blocking or inactive
findings.

The publisher must reject an oversized final comment. Snapshot decompression
must stop at the configured output limit.

If the publisher compacts state, it must add the compaction limitation to the
persisted state and the human projection in the same publication.

The workflow must pass bounded review input through a file. It must not place
the complete comment history in one command-line argument.

### requirement-review-boundary

The final note must state that the review agents did not execute pull-request
code, tests, builds, scripts, or checks. The note must not claim that the
workflow performed no Git operations.

## Detailed design or contracts

The state block uses schema version 3. The publisher places the state in a
collapsed Markdown details element after the human projection.

The state payload uses compact JSON. The publisher can use a bounded
`gzip+base64` wrapper when direct JSON exceeds the state budget.

Run timestamps and identifiers are audit data. They do not decide publication
order across revisions. The live pull-request head and full Git revisions
decide eligibility. For the same reviewed revision, the GitHub run ID and
attempt prevent an older run from replacing a newer publication. The workflow
serializes runs for one pull request so comment lookup and publication cannot
overlap.

The human status and severity labels are deterministic projections of the
validated state. Model output cannot select the final verdict or active
counts.

## Failure and edge cases

- Ignore state from an untrusted comment author.
- Ignore malformed, oversized, or unsupported state.
- Do not publish when the live pull request is closed, draft, or ineligible.
- Do not publish when the live head differs from the report head.
- Do not show a predecessor or delta when Git ancestry is not comparable.
- Keep a claimed fix active when verification is absent or uncertain.
- Keep all retained blocking findings before lower-priority history.

## Migration

The reader accepts legacy v1 and v2 snapshots during migration. The first v3
publication converts retained legacy findings to publisher-owned identifiers.

The v3 state stores legacy aliases when an existing disposition uses an old
identifier. New reports and commands use the v3 identifier.

## Verification

- Add schema compatibility and malformed-state tests.
- Add lifecycle transition and stable-identifier tests.
- Add current-head fix-verification tests.
- Add trusted-author and stale-head publication tests.
- Execute the exact publisher script with bounded representative state.
- Run the branch workflow against an open pull request.

## Acceptance criteria

- The comment contains a concise human projection and one bounded state block.
- The next review restores validated state from the trusted bot comment.
- Stable finding identifiers survive open, resolved, and reopened transitions.
- A fix claim cannot resolve a finding without current-head verification.
- An old or untrusted run cannot replace the authoritative comment.
- Mandatory limitation notices remain visible after output bounds apply.

## Traceability

- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Delivery: [task.publish-versioned-pull-request-review-comments](../tasks/2026-09-05-publish-versioned-pull-request-review-comments.md)
