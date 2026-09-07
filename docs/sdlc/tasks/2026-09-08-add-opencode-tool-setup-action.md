---
id: task.add-opencode-tool-setup-action
title: Add the OpenCode Tool Setup Action
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.opencode-tool-setup-action
supersedes: []
---

# Add the OpenCode Tool Setup Action

## Objective

Add `actions/setup-opencode` as a standalone Node 24 JavaScript Action. The
Action must install one requested OpenCode release, verify it, and output its
absolute executable path.

## Upstream requirements

Implement the setup contract in
[spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md).

Preserve the boundary in
[adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md).

Build on the workspace Action structure from
[task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md).

The sibling tasks own the Server Action input contract and review workflow
adoption:

- [task.require-explicit-opencode-server-executable](./2026-09-08-require-explicit-opencode-server-executable.md)
- [task.adopt-opencode-tool-setup-in-review-workflow](./2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md)

## Scope

- Add `actions/setup-opencode/action.yml` with one required `version` input.
- Add a Node 24 entrypoint and private setup implementation.
- Resolve Linux and macOS x64 and arm64 release assets.
- Download versioned official OpenCode release assets.
- Read upstream release metadata and verify SHA-256 digests.
- Use `@actions/tool-cache` for download, extraction, and tool placement.
- Add exact internal cross-run caching with no restore-key fallback.
- Verify cache hits and downloaded executables report the requested version.
- Publish one absolute `executable` output.
- Bundle and commit all Action runtime dependencies.
- Add focused tests for input, platform, release, cache, integrity, and output
  behavior.

## Out of scope

- Changes to `actions/opencode-server` inputs or lifecycle implementation. See
  [task.require-explicit-opencode-server-executable](./2026-09-08-require-explicit-opencode-server-executable.md).
- Review workflow changes. See
  [task.adopt-opencode-tool-setup-in-review-workflow](./2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md).
- A default OpenCode version or a public cache control.
- A skip-install mode or a preinstalled executable input in the Setup Action.
- Windows or unsupported runner architectures.
- Changes to OpenCode configuration, credentials, or review semantics.
- Changes to Seqlane application contracts or runtime behavior.
- Caching credentials, configuration, checkout files, Git state, or review
  outputs.

## Implementation plan

1. Inspect the supported `@actions/tool-cache` and `@actions/cache` APIs for
   the bundled Node 24 runtime.
2. Add the Setup Action metadata, package manifest, project target, TypeScript
   configuration, and source entrypoint.
3. Implement strict version input parsing and platform resolution before any
   cache or network operation.
4. Implement fixed official release URLs and release metadata parsing.
5. Implement archive download, SHA-256 verification, extraction, executable
   discovery, tool placement, and reported-version verification.
6. Implement the exact cache key and cache hit, miss, corruption, and error
   rules from the active spec.
7. Add tests that prove no wrong version is used after cache or download
   errors.
8. Build the committed Action bundle and inspect its runtime dependencies.
9. Run focused tests, typechecks, test mapping, and Action bundle checks.

## Affected areas

- `actions/setup-opencode/`
- `package.json`
- `pnpm-lock.yaml`

## Verification

Run the Setup Action unit tests for version parsing, platform resolution,
release metadata, digest verification, executable discovery, cache behavior,
and output paths.

Run the Setup Action typecheck, build, bundle-load, and bundle-drift checks.
Run `pnpm test:mapping` and the repository gates for the changed Action.

Parse the Setup Action metadata as YAML. Run `actionlint` when it is available.

Run `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

Use a temporary test directory for archive and cache fixtures. Do not use live
credentials, a target checkout, or a real review output during verification.

## Completion criteria

- The Setup Action exposes only the required `version` input and the
  `executable` output.
- The Action rejects unsupported platforms before cache or network access.
- The Action uses the exact official release asset and upstream SHA-256
  metadata for the requested version.
- Cache hits and downloaded executables pass exact reported-version checks.
- Cache keys contain the schema, runner OS, runner architecture, and version,
  with no restore-key fallback.
- Corrupt cache data cannot result in use of a wrong executable.
- Cache service errors do not alter exact-version setup behavior.
- Only the verified installation directory is saved in the cache.
- The Action uses Node 24, `@actions/tool-cache`, and committed bundled
  runtime dependencies.
- Focused tests, bundle checks, repository checks, and SDLC checks pass.

## Outcome

This task is planned. No Setup Action implementation is complete.

## Traceability

- [spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md)
- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md)
- [task.require-explicit-opencode-server-executable](./2026-09-08-require-explicit-opencode-server-executable.md)
- [task.adopt-opencode-tool-setup-in-review-workflow](./2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md)
