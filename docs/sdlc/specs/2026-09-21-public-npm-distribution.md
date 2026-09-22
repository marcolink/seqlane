---
id: spec.public-npm-distribution
title: Public npm Distribution
status: active
owners:
  - core
created: 2026-09-21
updated: 2026-09-22
upstream:
  - adr.preserve-workspace-release-references
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
release. Source manifests use `workspace:*` for group dependencies. Nx resolves
package versions but preserves these references. pnpm converts them to exact
versions only in package archives.

### requirement-supported-surface

`seqlane` and `@seqlane/core` are the supported public surface. The remaining
release packages are registry dependencies only. Private workspace packages
must not occur in a published package's production dependency closure.

### requirement-package-metadata

Each release package declares Apache-2.0, Node.js 24 or later, its repository
directory, public npm access, and provenance. Each package archive includes the
complete Apache-2.0 license text.

### requirement-release-automation

Nx uses fixed versioning, Conventional Commits, and a `v{version}` tag. A push
to `main` starts `publish.yml`. The workflow accepts only a public repository,
installs dependencies, and verifies and builds the release group. It then runs
the complete Nx release to version the packages, update the changelog, create
and push the release commit and tag, create the GitHub release, and publish the
packages.

For pre-1.0 versions, feature and fix commits that affect the release group
produce a patch release. A breaking change produces a minor release. Other
commits do not produce a release. The first eligible commit produces `0.0.1`.

The publish target uses pnpm 10.33.0 to create each package archive. It passes
the archive to npm 11.13.0 for publication. It supports Nx dry runs. The first
release can use `NPM_TOKEN`. The workflow grants OIDC permission for trusted
publishing after the initial package creation.

## Detailed design or contracts

The release group is selected with `tag:release:npm`. Nx derives publish order
from package dependencies. Package manifests remain the source of package
metadata.

## Failure and edge cases

The workflow must serialize release attempts from `main`. npm must reject an
existing package-version pair. Private repositories do not publish. A commit
with no semantic version impact must finish without a release.

## Migration

Publish `0.0.1` with `NPM_TOKEN`. Then configure `publish.yml` as the trusted
publisher for all eight packages. Verify OIDC before restricting token access.

## Verification

Run package tests and builds. Run `nx release publish --dry-run`. Inspect each
archive for its license and install the package set in an empty project. Source
manifests must keep `workspace:*`. Published manifests must not contain this
protocol.

## Acceptance criteria

- Nx selects exactly the eight tagged projects.
- A conventional-commit dry run infers `0.0.1` and previews the tag and GitHub
  release.
- A publish dry run succeeds through pnpm and npm.
- The CLI has no ACP or private workflow production dependency.
- Published metadata and documentation match this specification.

## Delivery state

Implementation is in progress on `chore/public-readiness`. Registry publication
and trusted-publisher setup remain pending.

## Traceability

- [adr.preserve-workspace-release-references](../adrs/2026-09-22-preserve-workspace-release-references.md)
- [task.publish-seqlane-packages](../tasks/2026-09-21-publish-seqlane-packages.md)
