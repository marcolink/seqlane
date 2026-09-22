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
to `main` starts `ci.yml`. The publish job requires the quality job and calls
the reusable `publish.yml` workflow. This workflow accepts only a public
repository. Its read-only build job creates exact-revision package artifacts.
The publish job consumes these artifacts. Nx then
versions the packages, updates the changelog, creates and pushes the release
tag, and creates the GitHub release without publishing. Version and changelog
changes stay in the release runner; the workflow does not push a commit to
`main`. The built-in short-lived workflow token has Contents write permission
for the tag and GitHub release only. The workflow validates the complete
package set and its archives before it runs the Nx publish phase.
Nx uses the generated changelog as the GitHub Release notes. The bounded job
summary uses the current GitHub Release body.

For pre-1.0 versions, feature and fix commits that affect the release group
produce a patch release. A breaking change produces a minor release. Other
commits do not produce a release. The first eligible commit produces `0.0.1`.

The publish target uses pnpm 10.33.0 to create each package archive. It passes
the archive to npm 11.13.0 for publication. It requires an explicit live or
dry-run intent and fails before packing when that intent is absent. The first
release can use `NPM_TOKEN`. The workflow grants OIDC permission for trusted
publishing after the initial package creation. A retry skips package-version
pairs that already exist and publishes the missing pairs.

## Detailed design or contracts

The release group is selected with `tag:release:npm`. Only the eight tagged
projects own the publish target. The workflow rejects any different project or
package set before publication. Package manifests remain the source of package
metadata.

## Failure and edge cases

The workflow must serialize release attempts from `main`. Private repositories
do not publish. A commit with no semantic version impact must finish without a
release. Insufficient GitHub token permission must not alter `main`. Missing
npm credentials must stop publication. A retry for a strict SemVer tag remains
valid after `main` advances only when the remote tag points to the triggering
commit and matches Nx's calculated version. It resumes after partial npm publication.

## Migration

Configure `ci.yml` as the trusted publisher for all eight packages. Verify an
OIDC release before you restrict or remove `NPM_TOKEN` access.

## Verification

Run package tests and builds. Run `nx release publish --dry-run` with explicit
dry-run intent. Inspect each archive for its license, metadata, version, files,
and production dependency closure. Install the package set in an empty project.
Source manifests must keep `workspace:*`. Published manifests must not contain
this protocol.

## Acceptance criteria

- Nx selects exactly the eight tagged projects.
- Publication stops if the selected projects, package metadata, archives, or
  production dependency closure differ from the expected release set.
- A conventional-commit dry run infers `0.0.1` and previews the tag and GitHub
  release.
- A publish dry run succeeds through pnpm and npm, and missing dry-run intent
  fails before either command runs.
- Release versioning uses only the non-publishing Nx choice. The built-in
  workflow token has Contents write permission for the release tag and GitHub
  Release. The workflow does not push a commit to `main` and needs no ruleset
  bypass actor.
- A retry after tag creation restores runner-local versions, first-release
  state, and Nx release notes. It continues after `main` advances or partial
  npm publication without storing the workflow token in Git configuration.
- The CLI has no ACP or private workflow production dependency.
- Published metadata and documentation match this specification.

## Delivery state

Version `0.0.1` is available from npm. CI integration and trusted-publisher
setup remain in progress.

## Traceability

- [adr.preserve-workspace-release-references](../adrs/2026-09-22-preserve-workspace-release-references.md)
- [task.publish-seqlane-packages](../tasks/2026-09-21-publish-seqlane-packages.md)
