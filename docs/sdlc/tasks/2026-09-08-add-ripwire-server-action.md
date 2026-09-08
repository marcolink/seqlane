---
id: task.add-ripwire-server-action
title: Add the Ripwire HTTP MCP GitHub Action
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.ripwire-server-action
supersedes: []
---

# Add the Ripwire HTTP MCP GitHub Action

## Objective

Add a self-contained workspace Action that acquires a pinned Ripwire release,
starts its HTTP MCP service for a checked-out workspace, verifies readiness,
and cleans up the detached process after the job.

## Upstream requirements

- Follow [spec.ripwire-server-action](../specs/2026-09-08-ripwire-server-action.md).
- Preserve [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md).
- Reuse [task.migrate-service-actions-to-workspace-structure](./2026-09-07-migrate-service-actions-to-workspace-structure.md)
  for the shared lifecycle boundary.

## Scope

- Add `actions/ripwire-server` metadata, TypeScript sources, tests, committed
  bundles, README, and process anchor.
- Add the exact release acquisition, checksum, archive, version, command,
  readiness, and cleanup behavior from the active spec.
- Add a hosted smoke job to `.github/workflows/unit-tests.yml`.
- Add this spec and task to the canonical SDLC indexes.

## Out of scope

- Adoption in `.github/workflows/seqlane-code-review.yml`.
- Changes to Ripwire upstream, the shared lifecycle library, or Seqlane
  application packages.
- A third-party installer or consuming-workflow dependency installation.

## Implementation plan

1. Define and test canonical inputs, security combinations, asset mapping, and
   exact command and environment construction.
2. Implement bounded release downloads, checksum verification, safe binary-only
   extraction, executable permissions, and version verification.
3. Implement HTTP MCP initialize readiness and lifecycle state/cleanup.
4. Add metadata, documentation, bundles, smoke workflow, and SDLC indexes.
5. Run mapping, focused tests, typecheck, bundle drift, YAML/actionlint,
   documentation, formatting, and diff checks.

## Affected areas

- `actions/ripwire-server/`
- `.github/workflows/unit-tests.yml`
- `tsconfig.json`
- `pnpm-lock.yaml`
- `docs/sdlc/specs/2026-09-08-ripwire-server-action.md`
- `docs/sdlc/tasks/2026-09-08-add-ripwire-server-action.md`
- `docs/sdlc/specs/index.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Run `pnpm test:mapping` before the focused Action suite.
- Run focused Ripwire tests, the Action and lifecycle typechecks, bundle build,
  bundle drift, and bundle runtime tests.
- Parse Action and workflow YAML and run `actionlint` when available.
- Run `pnpm docs:index`, `pnpm docs:validate`, and `pnpm docs:test`.
- Run formatting checks and `git diff --check`.

## Completion criteria

- The public contract and security defaults match the active spec.
- Release installation rejects invalid input, unsupported targets, unbounded or
  corrupt downloads, unsafe archives, and version mismatch.
- The service starts with exact arguments and environment, becomes ready only
  after a valid MCP initialize response, and cleans up on failure and post-job.
- The hosted smoke job uses read-only permissions and leaves code-review
  workflow adoption out of scope.
- Bundles and SDLC indexes are synchronized.

## Outcome

Implemented the self-maintained Ripwire Action with exact versioned release
asset downloads, bounded checksum-verified binary extraction, input and
security validation, HTTP MCP initialize readiness, identity-checked process
lifecycle, post cleanup, committed bundles, and a read-only hosted smoke job.
The code-review workflow remains unchanged as required.

The follow-up hardening also uses repository-pinned SHA-256 digests for each
supported Ripwire `0.4.0` asset, rejects versions outside that trust table, and
checks the pinned digest before extraction. It uses one startup deadline capped
at 600 seconds. It also applies strict protocol and server identity checks,
listen-port preflight, a unique
per-run bearer ownership token, post-readiness liveness checks, an explicit
child environment allowlist, direct-entry detection instead of a `NODE_ENV`
gate, child-exit process-anchor cleanup, one schema-validated service-state
value, typed startup cleanup outcomes, safe install-directory cleanup, and
typed handling for ambiguous spawn rejection. Post cannot retry such cleanup
without validated service state, so the install remains for runner-level
cleanup.

Focused Action typecheck, tests (61 tests), bundle build and drift checks,
test mapping, SDLC validation/tests, formatting, YAML parsing, and diff checks
passed. The existing shared lifecycle tests passed with host process
permissions. A local run of the production bundle downloaded Ripwire `0.4.0`,
published all outputs, completed MCP readiness, and ran post-job cleanup.
`actionlint` was not available locally. The hosted smoke job provides the
remote runner evidence.

## Traceability

- [spec.ripwire-server-action](../specs/2026-09-08-ripwire-server-action.md)
- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](./2026-09-07-migrate-service-actions-to-workspace-structure.md)
