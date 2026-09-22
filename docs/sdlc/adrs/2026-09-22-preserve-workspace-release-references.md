---
id: adr.preserve-workspace-release-references
title: Preserve Workspace References During npm Releases
status: accepted
owners:
  - core
created: 2026-09-22
updated: 2026-09-22
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
supersedes:
  - adr.public-npm-release
---

# Preserve Workspace References During npm Releases

## Context

Users need to install `seqlane` and author workflows with `@seqlane/core`.
The CLI uses seven workspace packages at run time. npm cannot install public
packages that contain unresolved `workspace:*` dependencies.

The source manifests must use `workspace:*`. This protocol makes local package
resolution explicit and prevents accidental registry resolution during
development. Release commits must not replace these references with versions.

npm trusted publishing requires the npm CLI. pnpm converts workspace
references when it packs a package. These constraints require separate pack
and publish commands.

## Decision

Publish the CLI, core, protocol, runtime, TUI, shared adapter contract, Codex
adapter, and OpenCode adapter. Mark them with the Nx tag `release:npm`.

Only `seqlane` and `@seqlane/core` are supported public APIs. The other
packages are public registry dependencies. Their exports have no compatibility
promise.

Do not publish workflows, GitHub Action packages, fixtures, or the ACP adapter.
The CLI supports the Codex and OpenCode adapters.

Use one fixed version for the release group. Start at `0.0.1`. Keep
`workspace:*` for source dependencies inside the release group. pnpm converts
these references to exact versions only in package archives.

Use Apache-2.0. Require Node.js 24 or later.

Nx owns versioning, changelog generation, tagging, and publish order. Its
publish target calls `pnpm pack` for each package. The target then calls
`npm publish` with the package archive. Pin pnpm to 10.33.0 and npm to 11.13.0.

Use `NPM_TOKEN` for the first release. After all packages exist, configure npm
trusted publishers for `publish.yml`. Keep OIDC permission in the workflow.

## Alternatives considered

Rewriting source dependencies during versioning was rejected. It creates
version-only source changes and removes the local-resolution guarantee.

Using Nx's inferred pnpm publisher was rejected. It does not call the npm CLI,
but npm trusted publishing currently requires that CLI.

A repository pack-and-publish script was rejected. The Nx target composes the
two native commands directly.

Independent versions were deferred. Fixed versions make the first release and
its dependency graph easier to inspect.

## Consequences

Release commits contain new package versions and unchanged `workspace:*`
dependencies. Published package archives contain exact registry versions.

The release workflow must install npm 11.13.0 and use pnpm 10.33.0. A package
manager upgrade must preserve the archive transformation and OIDC publication.

Eight packages appear on the public registry. Six are implementation details.
Every package release uses the same version and tag.

## Delivery state

Implementation is in progress on `chore/public-readiness`. No package has been
published by this decision.

## Traceability

- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [adr.public-npm-release](./2026-09-21-public-npm-release.md)
- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
- [task.publish-seqlane-packages](../tasks/2026-09-21-publish-seqlane-packages.md)
