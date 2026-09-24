---
id: adr.review-publication-without-comment-commands
title: Publish Review State Without Comment Commands
status: accepted
owners:
  - core
created: 2026-09-24
updated: 2026-09-24
upstream:
  - adr.direct-runtime-code-review-action
supersedes:
  - adr.github-native-review-publication-state
---

# Publish Review State Without Comment Commands

## Context

The earlier publication decision included a mechanical writer for comment
commands. Seqlane does not use those commands. The review workflow now admits
automatic pull request events in one review job. Manual dispatch needs a live
pull request check before it can enter the review job's cancellation group.

## Decision

Keep one trusted bot summary comment as the authoritative review checkpoint.
Its bounded, versioned state is compressed in the comment. Visible Markdown is
rendered from that state. Preserve bounded run metrics in the comment and put
detailed evidence for published runs in GitHub Actions artifacts. Do not add an
external state store or Git ref lock.

Only a completed review can change findings or publish state. Comments do not
trigger reviews or set finding decisions. A finding stores its original
severity and a lifecycle status. Current-head review and verification determine
that status. Version 4 state rejects former command, disposition, legacy
snapshot, and embedded run-history fields. Unsupported prior state is not
imported; the next review starts a new finding baseline in the existing bot
comment. The publication guard reads an older report identity only to replace
that comment safely. A valid run metrics ledger remains independent of finding
state.

Automatic, eligible pull request events enter the single review job directly.
A separate read-only admission job validates manual dispatch against the live
pull request before that dispatch can enter the cancellable per-PR group. A
closed pull request still cancels active review work.

For the proposed future publication path, an unqueued review producer seals
one candidate artifact, then dispatches a publisher. Review publishers alone
use a non-cancelling per-PR queue. The publisher rechecks live PR and comment
state before one final summary write. Recovery replays only sealed review
candidates whose write provably never started. Unknown write effects fail
closed. Enforce bounded payloads and visible size warnings; preserve the last
valid checkpoint if publication cannot complete.

## Alternatives considered

- Keep comment commands and a mechanical writer: rejected because the process
  does not use them and they add a second decision path.
- Admit manual dispatch directly to review concurrency: rejected because an
  ineligible dispatch could cancel an active review before validation.
- Put the checkpoint in artifacts or an external store: rejected because the
  comment is durable and already sufficient for the bounded checkpoint.

## Consequences

- No comment edit can cancel a review or change a finding.
- Unsupported previous finding state is discarded on the next review. Stable
  finding IDs can restart from the new baseline.
- Manual dispatch has one read-only validation job; automatic reviews still
  run in one review job.
- The future artifact and publication queue contract has one writer kind:
  review publication.

## Delivery state

This ADR records the decision. The current implementation and future
publication work are tracked by the linked specifications and tasks. Acceptance
does not claim delivery on the default branch.

## Traceability

- Runtime boundary: [adr.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md)
- Superseded decision: [adr.github-native-review-publication-state](./2026-09-14-github-native-review-publication-state.md)
- Current contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Future publication contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- Implementation: [task.simplify-pull-request-review-triggers](../tasks/2026-09-24-simplify-pull-request-review-triggers.md)
