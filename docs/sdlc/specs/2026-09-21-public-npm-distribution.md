---
id: spec.public-npm-distribution
title: Public npm Distribution
status: active
owners:
  - core
created: 2026-09-21
updated: 2026-10-23
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
to `main` or `next` starts `ci.yml`. The publish job requires the quality job.
It calls the reusable `publish.yml` workflow. This workflow accepts only a public
repository. Its read-only build job creates exact-revision package artifacts.
The publish job consumes these artifacts. Nx then
versions the packages, updates the changelog, creates and pushes the release
tag, and creates the GitHub release without publishing. Version and changelog
changes stay in the release runner; the workflow does not push a commit to
either branch. The built-in short-lived workflow token has Contents write
permission for the tag and GitHub release only. The workflow validates the complete
package set and its archives before it runs the Nx publish phase.
Nx uses the generated changelog as the GitHub Release notes. The bounded job
summary uses the current GitHub Release body.

On `main`, for pre-1.0 versions, feature and fix commits that affect the release group
produce a patch release. A breaking change produces a minor release. Other
commits do not produce a release. The first eligible commit produces `0.0.1`.

The publish target uses pnpm 10.33.0 to create each package archive. It passes
the archive to npm 11.13.0 for publication. It requires an explicit live or
dry-run intent and fails before packing when that intent is absent. The first
release used `NPM_TOKEN`. The workflow grants OIDC permission for trusted
publishing. It does not expose an npm token to the publish job. A retry skips
package-version pairs that already exist and publishes the missing pairs.

### requirement-release-channels

The branch determines the release channel. Other branches and pull requests
must not publish.

| Branch | Package version | npm dist-tag | GitHub release |
| --- | --- | --- | --- |
| `main` | Stable SemVer | `latest` | Stable |
| `next` | `X.Y.Z-beta.N` | `next` | Prerelease, never latest |

All eight packages use the same version and npm dist-tag. The publish target
must pass the selected tag to the actual `npm publish` command. Missing or
inconsistent channel information must stop publication before any write.

The first beta reserves at least the next minor stable version. Nx retains
its pre-1.0 breaking-change rules for both channels. Later eligible commits increment the beta number for that
target. Commits without release impact do not produce a beta. Stable hotfixes
do not change the reserved beta target. If a stable release reaches or exceeds
that target, stop beta publication until a higher target is selected.

Stable version calculation excludes beta tags. Beta version calculation uses
the reserved target and its beta tags. Changelog ranges include the migration
from its stable baseline. Promotion produces complete stable release notes.

After beta acceptance, merge `next` into `main` with its history intact.
Publish a fresh stable package set at the reserved target, without the beta
suffix. A change to an npm dist-tag alone does not promote prerelease versions.
Synchronize `main` into `next` before another beta series starts.

## Detailed design or contracts

The release group is selected with `tag:release:npm`. Only the eight tagged
projects own the publish target. The workflow rejects any different project or
package set before publication. Package manifests remain the source of package
metadata.

## Failure and edge cases

One shared publish lock must serialize release attempts across `main` and
`next`. The workflow must not cancel an active publish attempt. Private
repositories do not publish. A commit with no semantic version impact must finish without a
release. Insufficient GitHub token permission must not alter `main`. An OIDC
authentication failure must stop publication. A retry for a strict SemVer tag
remains valid after `main` advances only when the remote tag points to the triggering
commit and matches Nx's calculated version. It resumes after partial npm publication.

The stale-head rule applies to the selected branch before a new release.
Recovery selects only tags for the original channel, even when stable and beta
tags share a commit. Recovery preserves the original version, channel, and
GitHub prerelease status. It verifies remote tag identity before publication.
Recovery must not move either npm dist-tag to an older version. A registry
authentication or network error must not count as proof that a version is absent.

## Migration

Configure `ci.yml` as the trusted publisher for all eight packages. Run a
release without an npm token. After it succeeds, require two-factor
authentication and disallow bypass tokens on all eight packages. Then remove
the `NPM_TOKEN` secret and revoke the token.

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
- A beta dry run reaches all eight package archives and actual npm commands
  with one beta version, exact internal dependencies, and the `next` dist-tag.
- A second eligible beta increments only the beta number. A stable hotfix
  retains stable version selection and the `latest` dist-tag.
- Retries after branch advancement or partial publication preserve channel
  identity and do not move registry tags backward.
- Promotion publishes the stable target with complete release notes and no
  prerelease dependencies. Beta publication leaves every `latest` tag unchanged.

## Delivery state

On 2026-10-23, `seqlane@latest` is `0.2.1`. The verified `main` revision is
`6512cf84fe011831b455704f161c8de2cf8d7bb2`. It has the stable release path.

The `next` channel support is implemented locally under
`task.next-beta-releases`, pending PR validation and merge. Branch creation
and live beta publication remain pending. Local tests do not establish OIDC
or registry publication delivery.

## Traceability

- [adr.preserve-workspace-release-references](../adrs/2026-09-22-preserve-workspace-release-references.md)
- [task.publish-seqlane-packages](../tasks/2026-09-21-publish-seqlane-packages.md)
- [task.next-beta-releases](../tasks/2026-10-23-next-beta-releases.md)
