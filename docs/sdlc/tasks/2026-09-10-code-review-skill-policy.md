---
id: task.code-review-skill-policy
title: Enable Safe Repository Skills in Pull-Request Review
status: completed
owners:
  - core
created: 2026-09-10
updated: 2026-10-22
upstream:
  - spec.direct-runtime-code-review-action
  - spec.adapter-observation-projection
supersedes: []
---

# Enable Safe Repository Skills in Pull-Request Review

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Allow the trusted pull-request review runtime to use repository skills while
preserving the `pull_request_target` trust boundary and making each skill use
observable through canonical Seqlane observations.

## Upstream requirements

- Keep the review workflow definition and executable Action source trusted.
- Keep target project configuration disabled during privileged review.
- Treat skill text as untrusted prompt input and do not grant target skills
  additional filesystem, shell, or network permissions.
- Keep source-reported skill identity distinct from ordinary tool activity.

## Scope

- Discover target skills from supported repository skill roots.
- Stage only skill directories unchanged from the pull-request base revision.
- Allow OpenCode's `skill` tool explicitly while retaining the deny-by-default
  policy for other tools and project configuration.
- Emit bounded diagnostics for allowed and denied skill policy results.
- Retain source-reported skill identity and available payload in canonical observations.
- Retain bounded skill usage in Action publication metrics.
- Update the active OpenCode observability specification and review docs.

## Out of scope

- Executing new or modified pull-request skill text in privileged review.
- Enabling target `AGENTS.md`, `.opencode`, or arbitrary project configuration.
- Granting skills shell, edit, external-directory, or unrestricted network access.
- Adding a separate skill resolver or native trace tree.

## Implementation plan

1. Add a trusted skill-policy resolver used by the review workflow to stage
   base-unchanged skills and report exclusions.
2. Add explicit OpenCode `skill` permission and staged skill paths.
3. Project canonical skill activity and retain bounded publication metrics.
4. Add focused resolver, observability, metrics, and workflow contract tests.
5. Synchronize active SDLC documents and run focused repository checks.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `scripts/resolve-code-review-skills.mjs`
- `libs/seqlane-opencode/src/observability.ts`
- `libs/action-code-review/src/metrics.ts`
- active OpenCode observability and review documentation

## Verification

- `pnpm test:mapping`
- focused OpenCode and Action-library tests and builds
- resolver unit test
- workflow contract assertions
- `pnpm docs:index`
- `pnpm docs:validate`
- `git diff --check`

## Completion criteria

- An unchanged base skill is available to OpenCode in review.
- A new or modified target skill is diagnosed and excluded.
- OpenCode skill calls are explicitly permitted and identified by bounded name
  in canonical observations.
- Published run metrics retain bounded per-task skill counts without payloads.
- Project configuration and unrelated tool permissions remain denied.

## Outcome

Implemented the trusted repository-skill policy and observability projection.
The workflow disables target project configuration and external skill discovery,
stages only base-unchanged skill directories from the target checkout, and
explicitly permits only OpenCode's `skill` tool within the existing deny-by-
default policy. New and modified target skills are diagnosed and excluded.
OpenCode skill activity remained identifiable in telemetry. Action metrics
retained bounded, deduplicated per-task skill counts without skill payloads.
The later observation contract owns complete canonical payloads and truthful
availability. Historical telemetry limits do not restrict local capture.

Verification completed:

- resolver tests: 2 passed;
- OpenCode tests: 110 passed;
- Action-library tests: 43 passed;
- Action smoke/unit tests: 4 passed;
- OpenCode and Action builds passed;
- generated Action bundle was rebuilt twice with an identical SHA-256;
- test-to-implementation mapping: 246 mappings passed;
- formatting, ESLint, `pnpm docs:index`, `pnpm docs:validate`, and
  `git diff --check` passed.

## Historical delivery state

No commit or pull request yet. Current work is isolated in the
`codex/code-review-skill-policy` worktree.

The Action target's final `git diff --exit-code` bundle guard could not run to
completion in this linked worktree because its shared Git index/object metadata
is not writable. The source smoke/unit checks and deterministic rebuild check
passed; run the target unchanged after committing or in a writable checkout.

## Traceability

- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
- [spec.adapter-observation-projection](../specs/2026-10-22-adapter-observation-projection.md)
- [rfc.effect-v4-migration](../rfcs/2026-10-21-effect-v4-migration.md)
