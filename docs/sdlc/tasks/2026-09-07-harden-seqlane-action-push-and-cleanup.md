---
id: task.harden-seqlane-action-push-and-cleanup
title: Harden Seqlane Action Push and Cleanup
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Harden Seqlane Action Push and Cleanup

## Objective

This task prevents refused workflow-file pushes. It makes sure that OpenCode
always stops. It retains bounded diagnostics for Git push errors.

## Upstream requirements

Implement the push-token, least-privilege workflow, lifecycle, and diagnostics
requirements from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

## Scope

- Add the dedicated `push-token` Action input and production secret wiring.
- Keep metadata access on the read-only `GITHUB_TOKEN`.
- Reject a missing push token before integration or agent startup.
- Expose one lazy agent lifecycle with idempotent cleanup.
- Preserve bounded and sanitized Git push rejection diagnostics.
- Update tests, the committed Action bundle, operator documentation, and SDLC
  traceability.

## Out of scope

- Remote workflow execution or branch mutation.
- Changes to accepted ADRs.
- Changes to the OpenCode permission policy.

## Implementation plan

1. Add and mask the dedicated push token at the Action boundary.
2. Wire the lazy start, resolve, and stop lifecycle to one runner instance.
3. Sanitize and bound Git push stderr while preserving typed error codes.
4. Add lifecycle and diagnostics regression tests.
5. Update workflow, operator documentation, active spec, and this task.
6. Rebuild the committed Action bundle and run repository verification.

## Affected areas

- `actions/resolve-merge-conflicts/action.yml`
- `actions/resolve-merge-conflicts/src`
- `actions/resolve-merge-conflicts/dist/main.js`
- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `libs/action-merge-conflict-resolution/src/errors.ts`
- `libs/action-merge-conflict-resolution/src/commit-and-push.ts`
- `docs/sdlc/specs/2026-09-06-seqlane-action-merge-conflict-resolution.md`
- `examples/README.md`

## Verification

Run focused Action and resolver tests, typechecks, test mapping, bundle drift,
workflow checks, documentation checks, and formatting. Run `git diff --check`.
Do not use a real push token or mutate a remote branch locally.

## Completion criteria

- A push requires a non-empty dedicated token and the production workflow uses
  a read-only `GITHUB_TOKEN` for metadata.
- The Action adapter stops its one runner before push authentication and on
  failures.
- Push refusal diagnostics are bounded, sanitized, and secret-masked.
- Tests regress the previous lifecycle omission and diagnostic loss.
- The committed bundle matches source and all affected local gates pass.

## Outcome

The local implementation is complete. The focused tests, Action smoke test,
typechecks, lint, formatting, documentation validation, and deterministic
bundle rebuild passed.

The repository-wide spec typecheck still fails in existing pull-request review
example code outside this task. A hosted workflow run must verify the
`SEQLANE_RESOLVER_TOKEN` permissions and remote push.

## Traceability

- Specification: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Action workflow: [seqlane-resolve-merge-conflicts.yml](../../../.github/workflows/seqlane-resolve-merge-conflicts.yml)
