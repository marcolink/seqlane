---
id: task.publish-live-merge-resolution-progress
title: Publish Live Merge Resolution Progress
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-09
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Publish Live Merge Resolution Progress

## Objective

Show concise, safe resolver progress in the active GitHub Actions job log.

## Upstream requirements

Implement `requirement-observability-and-secrets` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

## Scope

- Report rebase commits-to-replay before integration with one bounded Git query.
- Report conflict stops separately from resolution passes.
- Report the current rebase commit with redacted, bounded identity data.
- Keep merge progress distinct from rebase progress.
- Keep live logs free of raw executor events, paths, model output, credentials,
  command arguments, and unbounded diagnostics.
- Preserve Action inputs, outputs, resolution behavior, and final summary.

## Out of scope

- Periodic heartbeats.
- New GitHub checks, comments, labels, or Action outputs.
- Changes to the conflict-resolution policy or prompts.

## Implementation plan

1. Add a typed private progress boundary and bounded formatter.
2. Capture rebase-plan count before integration and conflict-stop state during
   the controller loop.
3. Adapt formatted events to `core.info` in the Action entrypoint.
4. Test counters, event order, redaction, and compact rendering.
5. Rebuild the Action bundle and run scoped checks.

## Affected areas

- `libs/action-merge-conflict-resolution/src/`
- `actions/resolve-merge-conflicts/src/main.ts`
- `actions/resolve-merge-conflicts/dist/main.js`
- `docs/sdlc/specs/2026-09-06-seqlane-action-merge-conflict-resolution.md`

## Verification

- `pnpm run test:mapping`
- Resolver and Action unit tests and typechecks
- Action bundle rebuild and drift check
- `pnpm docs:index`
- `pnpm docs:validate`
- `pnpm format:check`
- `git diff --check`

## Completion criteria

- Rebase logs distinguish total commits, conflict stops, and resolution passes.
- Merge logs do not claim a rebase commit count.
- Published text is bounded and redacted.
- Existing Action outputs and final summary remain unchanged.

## Outcome

Completed. The resolver now emits compact, redacted job-log progress through a
private Action adapter. Rebase runs report the planned replay count, each
conflict stop, total resolution passes, and current rebase commit identity.
Merge runs report conflict sets without a rebase commit count. Existing Action
outputs and final job summary remain unchanged.

## Delivery state

Implemented and verified in this working tree. It is not delivered to a target
branch until a reachable commit is merged.

Delivery tracking: [PR #82](https://github.com/marcolink/seqlane/pull/82).

## Traceability

- [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
