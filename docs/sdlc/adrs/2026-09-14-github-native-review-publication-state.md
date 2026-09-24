---
id: adr.github-native-review-publication-state
title: Keep Review Publication State in a Comment and Evidence in Artifacts
status: superseded
owners:
  - core
created: 2026-09-14
updated: 2026-09-24
upstream:
  - adr.direct-runtime-code-review-action
supersedes: []
---

# Keep Review Publication State in a Comment and Evidence in Artifacts

Superseded by [adr.review-publication-without-comment-commands](./2026-09-24-review-publication-without-comment-commands.md). This document records the earlier proposal, including its mechanical writer.

## Context

Each review run needs the last published checkpoint and finding lifecycle. It
also needs bounded evidence to explain what that run inspected. A pull-request
comment is durable and easy to find, but its body has a finite size. GitHub
Actions artifacts offer more space but expire and require a run reference.

The current review proposal puts a publication journal and coordination data
in Actions artifacts and DynamoDB. That adds an external store and makes
publication depend on AWS availability and credentials. The review can instead
use GitHub's existing comment and artifact surfaces.

## Decision

Use one trusted bot summary comment as the authoritative review checkpoint.
Its versioned, bounded JSON state is compressed, base64-encoded, and placed in
an HTML comment block. The visible Markdown is a deterministic projection of
that state. No visible per-run JSON ledger is published. The hidden state owns
the reviewed revision, scope checkpoint, retained findings and lifecycle,
published-run identities, artifact references, and cost aggregates.

Store bounded structured manifest and evidence JSON for each **published**
review in one GitHub Actions artifact with 90-day retention. A run reads the
comment first. It retrieves a referenced artifact only for a specific audit
or reuse decision. An expired, missing, or invalid artifact disables that
use; it does not invalidate a structurally valid comment checkpoint. The
reviewer rechecks affected work and reports lost evidence detail.

The new review path makes one final authoritative-comment write after model
work. Action job status shows progress; it creates no progress or inline
comments. An unqueued producer seals and uploads the review candidate before
it dispatches a separate publisher. Full-review and mechanical-disposition
publishers use the same non-cancelling, per-PR Actions writer mutex. New
revisions cancel stale review computation, while queued publishers recheck
live state. At final publication,
the publisher re-reads the live PR, trusted comment, and authorized decisions;
it merges the completed run into that current state, renders the entire
comment, and writes it. That summary write is the checkpoint commit point.
GitHub comment writes do not provide compare-and-swap. No Git ref, extra
branch, DynamoDB table, or external service is used as a lock.

The Actions queue can cancel a pending writer when it is full. A trusted
default-branch recovery workflow replays sources whose comment mutation
provably never started. It uses bounded GitHub-native indexes and cursors to
find review candidates, authoritative comments, and current authorized
disposition commands. Replayed writers recheck live state and source identity
inside the same mutex. Unknown write effects remain unresolved instead of
being retried blindly. The recovery workflow does not write comments.

Upload and verify the run artifact before the final comment write. If the
write fails or its effect is unknown, read back the exact operation identity
and payload. A confirmed write remains published. A proven failed write leaves
the previous checkpoint intact and its unpublished artifact is deleted. An
unresolved write effect fails closed; it cannot trigger another checkpoint
write or silently discard the artifact before reconciliation.

The projection shows the known cumulative cost of published runs since this
state version began and the last published run cost. Missing provider cost is
not zero: mark the known total incomplete. Failed and cancelled runs do not
change the comment cost. A new state version begins a new labeled cost period.

Enforce explicit comment and payload size limits. Warn visibly as either
reaches 80% of its limit, with current and maximum sizes. If a hard limit is
reached, fail publication and preserve the previous checkpoint. Any bounded
state compaction or omitted projection detail must be visible to readers.

## Alternatives considered

### Comment only

Simple retrieval, but detailed evidence can exhaust the comment budget and
make every update large. Rejected for per-run evidence.

### Artifacts only

More capacity, but finding the latest valid checkpoint would require listing
prior runs and would depend on artifact retention. Rejected as the authority.

### DynamoDB coordinator and artifact journal

Offers conditional writes and exact aggregate reservations, but adds an
external dependency and operational setup. Rejected for this Action.

### Git ref as a write lock

Could serialize GitHub writes, but adds a branch or ref solely for coordination.
Rejected.

## Consequences

- The comment remains sufficient to resume review after artifacts expire.
- A review can use an artifact by direct ID without loading all earlier runs;
  initial delivery need not implement cross-run reuse.
- Publication must re-read and merge state inside the per-PR publisher queue.
- The queue protects only writers that use it. Unknown concurrent writers or
  lost write results require fail-closed reconciliation, not a false atomicity
  claim.
- Queue overflow needs idempotent replay from GitHub-owned sources. Candidate
  artifacts can exist temporarily before a review is confirmed published.
- Bounded GitHub-native control indexes support lookup, recovery, and hard
  admission without becoming the review checkpoint.
- Artifact retention limits historical evidence reuse to 90 days, while
  published state and aggregate cost remain in the comment.
- Hard size caps can stop a new publication. A visible warning gives users
  advance notice and preserves the last valid checkpoint.

## Delivery state

This ADR records the chosen contract. Implementation and delivery are tracked
by the linked specifications and tasks; this status does not claim delivery.

## Traceability

- [adr.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md)
- [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md)
