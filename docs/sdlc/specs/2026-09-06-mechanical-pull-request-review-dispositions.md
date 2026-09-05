---
id: spec.mechanical-pull-request-review-dispositions
title: Mechanical Pull Request Review Dispositions
status: draft
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream: []
supersedes: []
---

# Mechanical Pull Request Review Dispositions

## Summary

Authorized `wont-fix` and `downgrade` decisions update an existing pull-request
review mechanically. They do not start an agentic review. Full review remains
reserved for pull-request events and an explicit review request.

## Goals

- Verify every retained finding automatically on the next reviewed head.
- Apply human policy decisions without model work.
- Prevent an agent run that started earlier from erasing a later human decision.
- Keep the trusted report and its bounded state internally consistent.

## Non-goals

- Execute pull-request code or checks.
- Create a public Seqlane package contract.
- Retain unbounded command history.

## Requirements

### requirement-review-triggers

Eligible pull-request lifecycle events and `/seqlane review` schedule a full
review. `/seqlane fixed`, `/seqlane wont-fix`, and `/seqlane downgrade` must
not cancel an in-progress full review.

A `fixed` command starts no workflow. Every retained finding is independently
verified when the next normal review runs for a pushed head. A fixed command
can remain as non-authoritative human provenance.

### requirement-mechanical-dispositions

An authorized `wont-fix` or `downgrade` command, including an edit that adds,
removes, or retargets one, schedules only a mechanical disposition publication.
It must not check out the review target, start OpenCode, invoke the Seqlane CLI,
or consume model credentials.

The mechanical publisher validates the trusted report, command, authorization,
and target finding. A missing report or unknown finding leaves the report
unchanged and emits a clear workflow notice.

### requirement-serialized-publication

Every authoritative-comment mutation uses one shared per-pull-request
publication queue. The queue must not cancel an in-progress writer and must
retain pending writers in arrival order.

After it acquires the queue, every writer reads the live trusted report and the
latest bounded command ledger. It derives the next report from that data, not
only from its original webhook payload. Raw authorized command comments are the
durable source of human decisions; the trusted report is their projection.

A full-review publisher must acquire the same queue after agent computation,
then reconcile its result with any decisions that arrived during computation.
It must not overwrite those decisions.

### requirement-state-migration

The next state schema is version 4. It adds a monotonic state revision and
writer identity. Readers accept valid versions 1 through 3 and migrate retained
state on the next write.

### requirement-human-projection

The human projection must not render slash-command syntax until the mechanical
path is implemented and verified. This does not change command parsing or
legacy-state compatibility.

## Failure and edge cases

- A command posted after a publisher reads but before it patches is processed
  by its subsequent queued mechanical publisher. The command cannot be lost.
- A disposition publisher preserves another run's progress marker.
- Progress cleanup removes only the marker owned by its run.
- A full review still refuses to publish output for a different live head.

## Verification

- Test command routing and prove mechanical routes do not start agent tooling.
- Test v1-v4 state compatibility and malformed input.
- Test decisions arriving during computation, during publication, and queued
  behind another decision.
- Test edited and removed commands converge to the current ledger.

## Acceptance criteria

- `wont-fix` and `downgrade` update an existing report without agent work.
- `fixed` does not start a workflow.
- Every retained finding is verified on the next reviewed head.
- No review publication erases a later authorized disposition.
- The human report omits slash-command syntax until the mechanical path ships.

## Traceability

- Current contract: [spec.versioned-pull-request-review-comments](2026-09-05-versioned-pull-request-review-comments.md)
- Delivery: [task.mechanical-pull-request-review-dispositions](../tasks/2026-09-06-mechanical-pull-request-review-dispositions.md)
