---
id: task.publish-seqlane-packages
title: Publish Seqlane Packages
status: in-progress
owners:
  - core
created: 2026-09-21
updated: 2026-09-22
upstream:
  - spec.public-npm-distribution
supersedes: []
---

# Publish Seqlane Packages

## Objective

Prepare the repository for its first public npm release.

## Upstream requirements

Implement all requirements in
[spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md#requirements).

## Scope

- Public package metadata and workspace dependency references that Nx resolves
  to exact versions during release versioning.
- Apache-2.0 licensing and Node.js 24 support.
- Fixed Nx release configuration and npm publishing.
- A main-branch semantic release workflow.
- Removal of ACP and private workflow dependencies from the CLI closure.
- Public and contributor documentation.

## Out of scope

- Publishing `0.0.1` during pull-request validation.
- npm trusted-publisher configuration after the first publish.
- Independent package versions.

## Implementation plan

1. Mark the runtime closure with `release:npm`.
2. Remove private dependencies from that closure.
3. Configure Nx fixed releases and npm publishing.
4. Add the semantic release workflow and release documentation.
5. Build, test, pack, and install the release set.

## Affected areas

Package manifests, Nx configuration, the CLI adapter boundary, GitHub Actions,
documentation, and the lockfile.

## Verification

Run mapping checks, tooling tests, focused lint, builds, tests, a complete
semantic release dry run, documentation checks, and an install smoke test from
packed artifacts.

## Completion criteria

- All local verification passes.
- The pull request is reviewable.
- Publication starts only after an eligible commit reaches public `main`.

## Outcome

The local branch defines an eight-package fixed release group through the
`release:npm` tag. It removes ACP and private workflows from the CLI production
closure. Nx derives pre-1.0 fixed versions from Conventional Commits. The
main-branch workflow creates the release commit, tag, and GitHub release before
publishing. Nx publish dry runs use npm and pass for all eight packages. A
fresh project can install the packed artifacts, import `@seqlane/core`, and
run the `seqlane` executable.

Two unchanged timing-sensitive integration tests fail in this macOS worktree:
the non-cooperative MCP deadline test and the operational-route timeout test.
Remote Linux verification remains pending.

## Delivery state

Work is under review in [pull request #144](https://github.com/marcolink/seqlane/pull/144).
Remote checks, merge, and registry release remain pending.

## Traceability

- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
- [adr.public-npm-release](../adrs/2026-09-21-public-npm-release.md)
- [Delivery pull request #144](https://github.com/marcolink/seqlane/pull/144)
