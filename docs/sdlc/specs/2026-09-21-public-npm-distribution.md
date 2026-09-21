---
id: spec.public-npm-distribution
title: Public npm Distribution
status: active
owners:
  - core
created: 2026-09-21
updated: 2026-09-21
upstream:
  - adr.public-npm-release
supersedes: []
---

# Public npm Distribution

## Summary

Seqlane publishes an installable CLI and workflow-authoring API from one fixed
Nx release group.

## Goals

- Install `seqlane` and `@seqlane/core` from the public npm registry.
- Publish every package required by the CLI at run time.
- Publish from GitHub Actions with provenance and trusted-publishing support.

## Non-goals

- A supported API for runtime implementation packages.
- Publishing workflows, fixtures, GitHub Actions, or the ACP adapter.
- Independent package versions.

## Terminology

- **Supported API:** an import or command intended for user code.
- **Registry dependency:** a public package required by a supported package.

## Requirements

### requirement-release-group

The `release:npm` Nx tag defines the release group. The group contains
`seqlane`, core, protocol, runtime, TUI, the shared adapter contract, and the
Codex and OpenCode adapters. All members use version `0.0.1` for the first
release and exact versions for group dependencies.

### requirement-supported-surface

`seqlane` and `@seqlane/core` are the supported public surface. The remaining
release packages are registry dependencies only. Private workspace packages
must not occur in a published package's production dependency closure.

### requirement-package-metadata

Each release package declares Apache-2.0, Node.js 24 or later, its repository
directory, public npm access, and provenance.

### requirement-release-automation

Nx uses fixed versioning and a `v{version}` tag. A tag push starts
`publish.yml`. The workflow accepts only a public repository and a commit that
is reachable from `main`. It installs dependencies, verifies and builds the
release group, then runs `nx release publish`.

The publish target uses npm 11.5.1 or later. It supports Nx dry runs. The first
release can use `NPM_TOKEN`. The workflow grants OIDC permission for trusted
publishing after the initial package creation.

## Detailed design or contracts

The release group is selected with `tag:release:npm`. Nx derives publish order
from package dependencies. Package manifests remain the source of package
metadata.

## Failure and edge cases

The workflow must stop when the tag does not match every package version. npm
must reject an existing package-version pair. Private repositories do not
publish.

## Migration

Publish `0.0.1` with `NPM_TOKEN`. Then configure `publish.yml` as the trusted
publisher for all eight packages. Verify OIDC before restricting token access.

## Verification

Run package tests and builds. Run `nx release publish --dry-run`. Inspect each
tarball and install the package set in an empty project.

## Acceptance criteria

- Nx selects exactly the eight tagged projects.
- A publish dry run succeeds with npm.
- The CLI has no ACP or private workflow production dependency.
- Published metadata and documentation match this specification.

## Delivery state

Implementation is in progress on `chore/public-readiness`. Registry publication
and trusted-publisher setup remain pending.

## Traceability

- [adr.public-npm-release](../adrs/2026-09-21-public-npm-release.md)
- [task.publish-seqlane-packages](../tasks/2026-09-21-publish-seqlane-packages.md)
