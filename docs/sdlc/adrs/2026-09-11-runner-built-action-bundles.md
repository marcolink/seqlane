---
id: adr.runner-built-action-bundles
title: Build Repository-Local GitHub Actions on the Runner
status: accepted
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - adr.seqlane-action-library-boundary
  - adr.direct-runtime-code-review-action
supersedes: []
---

# Build Repository-Local GitHub Actions on the Runner

## Context

Seqlane has six repository-local Node 24 Actions. Their ten committed main and
post bundles occupy about 31 MiB. Any Action source or transitive library change
requires the pull request to regenerate those files. The bundle gate also
treats every `libs/` change as relevant, rebuilds every Action, and disables the
Nx cache. This causes unrelated pull requests and correctly changed source to
fail on generated-file drift.

The Actions are invoked only after a trusted Seqlane source checkout. No known
external repository consumes them through `owner/repository/path@ref`.

## Decision

Keep the existing JavaScript Action metadata, inputs, outputs, Node 24 runtime,
and main/post lifecycle. Change their distribution model from committed bundles
to runner-built bundles:

- Ignore `actions/*/dist/` and do not commit bundle output.
- Install the frozen trusted-source dependency graph and materialize every
  required local Action before its first `uses: ./...` step.
- Build from the explicit trusted workflow revision. Privileged workflows must
  use `github.workflow_sha`; an untrusted target checkout must never provide
  Action source, dependencies, or bundle output.
- Make each Action build one atomic, cacheable Nx task with declared inputs and
  `dist` outputs. Nx decides whether to restore the output or run esbuild.
- Persist the Nx computation cache across runner jobs. A missing, unavailable,
  or corrupt cache must cause a normal build or a safe failure; it must not
  select different source.
- Keep source tests, bundle-loading tests, Action metadata validation, and
  GitHub-hosted local-Action execution. Remove committed-file drift checks.
- Require a separate release and immutable bundle publication decision before
  any Action becomes an external `owner/repository/path@ref` contract.

This decision replaces only the committed-bundle and consumer-installation
clauses of `adr.seqlane-action-library-boundary` and
`adr.direct-runtime-code-review-action`. Their library boundaries, runtime
service, workflow composition, lifecycle, and security decisions remain in
force.

## Alternatives considered

### Keep committed bundles and improve the drift gate

Accurate affected detection reduces false positives but retains generated
files, large diffs, and mandatory rebuild commits for every real dependency
change. Rejected.

### Replace the Actions with workflow shell or inline JavaScript

This removes bundling but loses typed Action contracts and the existing main
and post lifecycle. It also moves tested application behavior into workflow
YAML. Rejected for this mitigation.

### Publish the Actions separately

This supports external consumers but adds release versioning and artifact
publication. No current consumer needs that contract. Deferred until required.

## Consequences

### Positive

- Source changes no longer create generated-file diffs.
- A cache hit restores the exact `dist` output required by the local Action.
- Cache misses remain correct because the runner can rebuild from trusted
  source.
- Action contracts and cleanup behavior do not change.

### Negative

- A cold runner must install trusted dependencies and build required Actions.
- Workflows must materialize local Actions before `uses:`.
- The repository can no longer be consumed directly as an external JavaScript
  Action without a separate published bundle.

### Security consequences

- Shared bundle caches must be content-addressed by Nx and scoped so untrusted
  target code cannot seed privileged execution.
- Privileged workflows build only the trusted `github.workflow_sha` checkout.
- Cache restoration never replaces input validation, frozen installation, or
  bundle-loading tests.

## Delivery state

Implementation is tracked by `task.migrate-to-runner-built-action-bundles`.
Acceptance records the decision; it does not prove delivery on `main`.

## Traceability

- [adr.seqlane-action-library-boundary](./2026-09-06-seqlane-action-library-boundary.md)
- [adr.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md)
- [task.migrate-to-runner-built-action-bundles](../tasks/2026-09-11-migrate-to-runner-built-action-bundles.md)
