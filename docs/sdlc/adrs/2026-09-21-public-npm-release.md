---
id: adr.public-npm-release
title: Publish Seqlane Packages to npm
status: accepted
owners:
  - core
created: 2026-09-21
updated: 2026-09-21
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
supersedes: []
---

# Publish Seqlane Packages to npm

## Context

Users need to install `seqlane` and author workflows with `@seqlane/core`.
The CLI uses several workspace packages at run time. npm cannot install private
dependencies from a public package.

## Decision

Publish the CLI, core, protocol, runtime, TUI, shared adapter contract, Codex
adapter, and OpenCode adapter. Mark them with the Nx tag `release:npm`.

Only `seqlane` and `@seqlane/core` are supported public APIs. The other
packages are public registry dependencies. Their exports have no compatibility
promise.

Do not publish workflows, GitHub Action packages, fixtures, or the ACP adapter.
The CLI supports the Codex and OpenCode adapters.

Use one fixed version for the release group. Start at `0.0.1`. Use exact
versions for dependencies inside the release group. A later decision can move
the group to independent versions.

Use Apache-2.0. Require Node.js 24 or later.

Nx owns versioning, changelog generation, tagging, and publish ordering. The
Nx publish target calls npm because npm trusted publishing requires the npm
CLI. A tag workflow publishes only commits reachable from `main`.

Use `NPM_TOKEN` for the first release. After all packages exist, configure npm
trusted publishers for `publish.yml`. Keep OIDC permission in the workflow.

## Alternatives considered

Publishing only the CLI and core was rejected because the CLI has unbundled
runtime dependencies. Bundling the full runtime was rejected for this release.

Independent versions were deferred. Fixed versions make the first release and
its dependency graph easier to inspect.

Using Nx's inferred pnpm publisher was rejected because npm trusted publishing
requires `npm publish`.

## Consequences

Eight packages appear on the public registry. Six are implementation details.
Every package release uses the same version and tag. Release automation needs
an npm token until trusted publishing is configured.

## Delivery state

Implementation is in progress on `chore/public-readiness`. No package has been
published by this decision.

## Traceability

- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
