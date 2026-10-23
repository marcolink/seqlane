---
id: task.next-beta-releases
title: Release Effect Migration Betas from next
status: in-progress
owners:
  - core
created: 2026-10-23
updated: 2026-10-23
upstream:
  - spec.public-npm-distribution
supersedes: []
---

# Release Effect Migration Betas from next

## Objective

Add beta publishing before the Effect migration moves to `next`.
Implement [release channels](../specs/2026-09-21-public-npm-distribution.md#requirement-release-channels)
through the existing Nx release path.

## Scope

- Admit pushes to `next` through the existing quality and publication jobs.
- Pass `--preid beta` to Nx on `next`; publish with npm tag `next`.
- Keep `main` on stable versions and npm tag `latest`.
- Preserve tag recovery for each channel and serialize publication.

## Verification

Run test mapping, release tooling tests, workflow lint, and documentation checks.
Use an isolated Git repository to verify native Nx beta increments, no-impact
commits, stable releases, and recovery. Dry-run npm publication with tag `next`.

## Outcome

Publishing support is proposed in [PR #182](https://github.com/marcolink/seqlane/pull/182),
based on `main`. It can merge before the Effect migration.
Local tooling tests and the isolated release smoke test pass.
Branch creation, migration PR retargeting, and live beta publication follow
after this PR. This task remains in progress until a beta is published.

## Traceability

- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
- [Effect migration PR #180](https://github.com/marcolink/seqlane/pull/180)
- [Beta publishing PR #182](https://github.com/marcolink/seqlane/pull/182)
