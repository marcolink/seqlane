---
id: adr.use-runner-local-nx-cache
title: Use Runner-Local Nx Cache
status: accepted
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - adr.runner-built-action-bundles
supersedes: []
---

# Use Runner-Local Nx Cache

## Context

The runner-built Action decision required `.nx/cache` persistence across
GitHub-hosted runners. Hosted run `34584861924` restored those files, but Nx 22
reported them as unrecognized artifacts because the new runner did not own the
corresponding local cache metadata. The Action bundles rebuilt normally.

Copying a local Nx cache between machines is not a supported remote-cache
implementation. The ineffective restore steps add time and configuration
without avoiding work.

## Decision

Do not copy `.nx/cache` between GitHub-hosted runners with `actions/cache`.
Use Nx caching only within each runner job. A consuming workflow installs the
trusted dependency graph and builds each required local Action before use.

This amends only the cross-run persistence clause in
`adr.runner-built-action-bundles`. Action contracts, trusted-source builds,
cacheable build targets, ignored bundle output, and bundle-loading tests remain
unchanged. Adopt a supported Nx remote cache only through a separate decision.

## Alternatives considered

### Cache local artifacts and metadata together

Nx local cache state is machine-specific and is not a supported remote cache.
Rejected.

### Disable Nx unknown-artifact validation

This bypasses an integrity check instead of providing supported cache
ownership. Rejected.

### Configure a supported remote Nx cache now

This needs provider, access, cost, and untrusted-pull-request decisions.
Deferred.

## Consequences

- CI no longer runs ineffective cache restore and save steps.
- One CI job reuses its local Nx cache and task graph.
- Code-review and resolver jobs rebuild required Actions on a cold runner.
- Action source and output selection remain deterministic and trusted.

## Delivery state

Implementation is under review in
[pull request 98](https://github.com/marcolink/seqlane/pull/98). It is not
delivered on `main`.

## Traceability

- [adr.runner-built-action-bundles](./2026-09-11-runner-built-action-bundles.md)
- [Migration task](../tasks/2026-09-11-migrate-to-runner-built-action-bundles.md)
