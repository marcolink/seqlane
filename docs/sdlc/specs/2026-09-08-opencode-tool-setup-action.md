---
id: spec.opencode-tool-setup-action
title: OpenCode Tool Setup Action
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-11
upstream:
  - adr.seqlane-action-library-boundary
  - adr.runner-built-action-bundles
  - task.migrate-service-actions-to-workspace-structure
supersedes: []
---

# OpenCode Tool Setup Action

## Summary

Add a standalone `actions/setup-opencode` JavaScript Action. The Action
resolves one exact OpenCode version for the runner platform, verifies the
executable, and publishes its absolute path.

The Action uses an exact cross-run cache for speed. Cache use does not
change the version, platform, verification, output, or failure contract.

The existing `actions/opencode-server` Action remains a service lifecycle
Action. It starts, readiness-checks, and stops an executable supplied by the
caller. It does not install or cache OpenCode.

## Goals

- Provide one explicit setup contract for a pinned OpenCode CLI version.
- Support Linux and macOS runners with x64 and arm64 architectures.
- Download only the official release artifact for the requested version.
- Verify release metadata and the executable before the Action returns.
- Use an exact internal cache to reduce repeated downloads.
- Keep installation, configuration, credentials, and review policy separate.
- Replace the review workflow's inline OpenCode installer.
- Keep all Action code outside Seqlane application contracts.

## Non-goals

- Extending `actions/opencode-server` with installation or cache behavior.
- Adding a public cache toggle, a skip-install input, or a default version.
- Selecting `latest`, a version range, a mirror, or an alternate executable.
- Changing OpenCode configuration, permission policy, or review behavior.
- Adding OpenCode types or dependencies to Seqlane application packages.
- Supporting runner platforms without an official supported artifact.

## Terminology

- **Requested version**: the exact value supplied through the `version` input.
- **Release artifact**: the official archive for one version and platform.
- **Installation directory**: the Action-owned directory that contains the
  verified OpenCode executable.
- **Cache entry**: an exact GitHub Actions cache entry for one platform and
  requested version.
- **Setup Action**: `actions/setup-opencode`.
- **Server Action**: `actions/opencode-server`.

## Requirements

### requirement-action-boundary

The Setup Action must own version resolution, release download, integrity
verification, installation placement, executable verification, and its output.

The Server Action must own only service startup, readiness, state, logs, and
cleanup. The Server Action must receive an explicit executable path from each
caller. The Server Action must not install, resolve, or cache OpenCode.

The Action code must remain outside Seqlane core, runtime, workflow authoring,
Plan IR, runner IPC, and public executor contracts.

### requirement-input-version

The Setup Action must expose one required public input named `version`.

The input must be a non-empty exact release version. It must not accept
`latest`, a range, a wildcard, a local path, or a shell expression.

The Action must not declare a default version. It must not expose a public
cache toggle or a skip-install input.

The Action must use the requested version in every release URL, cache key,
verification result, and output decision.

### requirement-platform-resolution

The Action must resolve the runner platform before cache restore or download.
It must support this platform matrix:

| Runner platform | Release asset |
| --- | --- |
| Linux x64 | `opencode-linux-x64.tar.gz` |
| Linux arm64 | `opencode-linux-arm64.tar.gz` |
| macOS x64 | `opencode-darwin-x64.zip` |
| macOS arm64 | `opencode-darwin-arm64.zip` |

The Action must reject every other operating-system and architecture pair
before it reads or writes a cache entry and before it downloads an artifact.

The Action must map platform values from the Node runtime to these asset names.
It must not infer the platform from the target checkout or from a user value.

### requirement-release-source

The Action must use the official OpenCode release for the requested version.
The release tag must be `v<version>` and the asset name must match the
resolved platform pair.

The Action must use versioned GitHub release assets. It must not execute the
mutable `https://opencode.ai/install` script, use an unversioned URL, or use a
fallback mirror.

The Action must obtain the expected SHA-256 digest from upstream-published
GitHub release metadata for the selected asset. Missing, malformed, or
ambiguous metadata must fail setup.

### requirement-integrity

The Action must verify the downloaded archive against the upstream-published
SHA-256 digest before extraction or executable use.

The Action must extract only the selected release artifact. It must locate the
expected `opencode` executable in the extracted content and reject a missing,
duplicate, or unexpected executable.

The Action must verify that the executable reports exactly the requested
version before it writes the output. A version mismatch must never produce a
successful setup result.

The Action must apply the same executable verification after every cache
restore. It must not use a cached executable when the file is missing,
unreadable, or reports another version.

### requirement-installation

The Action must use `@actions/tool-cache` for artifact download, archive
extraction, and tool placement.

The installation directory must be owned by the Action or by the runner tool
cache. The Action must add the directory that contains the executable to the
Action process path only after verification.

The output path must be absolute and must identify the verified executable.
The Action must not write the executable into the reviewed checkout.

All runtime dependencies must be included in the runner-built Action output.
The Action must use the Node 24 runtime. The consuming workflow must install
and build only the trusted Seqlane source checkout before local invocation.

### requirement-cache

The cache is an internal performance optimization. A cache miss, unavailable
cache service, restore denial, or save denial must not change setup semantics.

The Action must use an exact key with these ordered components:

```text
seqlane-opencode-tool-v1-<runner-os>-<runner-arch>-<requested-version>
```

The `v1` component identifies the Action cache schema. The operating-system,
architecture, and requested-version components are required partitions. The
Action must not use restore keys or prefix fallback.

The Action must save only the verified installation directory. It must never
cache credentials, OpenCode configuration, the target checkout, Git state,
review outputs, or unrelated runner files.

On a valid cache hit, the Action must verify the executable and its reported
version before it publishes the output.

On a cache miss, the Action must download, verify, install, and verify the
requested version before it attempts to save the installation directory.

If restored data is corrupt or mismatched, the Action must ignore that data
and perform an exact-version download in a fresh directory. It must not use
the corrupt data or fall back to another cache key or version. Setup fails
only when the exact download or its verification fails.

The implementation must use `@actions/cache` for cross-run persistence. Cache
errors must be reported as notices or debug information without exposing
secrets.

### requirement-output

The Setup Action must declare one output named `executable`.

The output must contain the absolute path to the verified executable. The
Action must set this output only after platform resolution, installation or
cache restore, and executable version verification succeed.

The Action must fail with a clear error when the input, platform, release
metadata, archive, digest, executable, or reported version is invalid.

### requirement-security

The Action must construct download, extraction, and version commands without
shell interpolation. It must bound archive handling according to the selected
tool-cache and runtime APIs.

The Action must not print credentials, authorization headers, OpenCode
configuration, or the contents of the target checkout. It must not read
configuration from the target checkout during setup.

The Action must verify release metadata as untrusted external input. It must
fail closed when the selected asset, digest, or release tag is absent or does
not match the requested version.

### requirement-workflow-integration

The review workflow must remove its inline OpenCode installer. The workflow
must derive the OpenCode version from its explicit SDK compatibility policy.
It must compare that version with the pinned `@opencode-ai/sdk` version. It
must pass the matched version to the Setup Action.

The workflow must pass the Setup Action's `executable` output to the Server
Action through its required executable input. The workflow must retain
OpenCode configuration and credentials as workflow-owned values.

A workflow with a preinstalled OpenCode executable can omit the Setup Action.
It must pass an explicit absolute executable path to the Server Action and
must retain responsibility for that executable's version policy.

The Server Action's new contract must make `executable` required and remove
its current default. This is a contract-tightening change only. It must not
add installation or cache behavior to the Server Action.

## Detailed design or contracts

The Setup Action entrypoint reads `version`, resolves the runner platform, and
selects one fixed release asset. It obtains release metadata, verifies the
asset digest, and uses `@actions/tool-cache` for download, extraction, and
tool placement. The implementation must keep all command arguments separate.

The Action must try to restore the exact cache entry before download. A
restored entry is usable only after executable and version verification. A
bad entry is ignored, and the Action downloads the same requested version
into a fresh installation directory.

After a cache miss, the Action must try to save the verified installation
directory. A cache save conflict or cache service error does not fail setup.
The Action never uses a different version to satisfy the request.

The release metadata adapter must select the `v<version>` GitHub release and
the platform asset. It must read one SHA-256 digest and compare it with the
downloaded archive. It must not trust an archive because its URL contains the
requested version.

The Action's public metadata must contain `runs.using: node24`, a `main`
entrypoint, the required `version` input, and the `executable` output. It does
not need a post entrypoint because it owns no long-lived process.

The Server Action remains the next workflow step. It starts the executable,
performs its existing readiness operation, and cleans up its process group in
its existing post path.

## Failure and edge cases

- Blank, ranged, mutable, or malformed versions fail before cache access.
- Unsupported operating-system and architecture pairs fail before cache
  access or download.
- Missing or ambiguous release metadata fails setup.
- A release tag or asset name that does not match the request fails setup.
- A digest mismatch fails setup and prevents extraction or executable use.
- An archive without the expected executable fails setup.
- An executable that reports another version fails setup.
- A cache miss does not fail setup when the exact download succeeds.
- Cache restore, cache save, or cache eviction errors do not select another
  version.
- Corrupt restored data is ignored and replaced by an exact fresh download.
- An exact download or verification error fails setup with no executable
  output.
- A preinstalled workflow path remains valid only when it supplies an explicit
  absolute executable path to the Server Action.

## Migration

Add `actions/setup-opencode` with its Action metadata, Node 24 entrypoint,
private implementation, tests, and runner-built bundled dependencies.

Update `.github/workflows/seqlane-code-review.yml` to derive and compare the
SDK-matched version, call the Setup Action, and pass its output to
`actions/opencode-server`.

Update `actions/opencode-server/action.yml` and its input adapter so that
`executable` is required and has no default. Do not add setup logic to that
Action.

Keep OpenCode configuration, credentials, target checkout, Git state, and
review output ownership in the workflow or existing service and review code.

## Verification

- Parse the new and changed Action metadata as YAML.
- Unit-test exact version parsing and platform-to-asset mapping.
- Unit-test unsupported platform rejection before cache or network access.
- Unit-test release tag, asset, and digest metadata handling.
- Unit-test cache key composition and the absence of restore-key fallback.
- Unit-test cache-hit, cache-miss, corrupt-cache, and cache-error behavior.
- Unit-test executable discovery and exact reported-version verification.
- Test that cache paths exclude credentials, configuration, checkout, Git
  state, and review output.
- Build the Action bundle and verify that its runtime entrypoint loads.
- Run focused Action tests, typechecks, test mapping, and workflow metadata
  checks.
- Run `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.
- Run `actionlint` when it is available in the environment.

## Acceptance criteria

- `actions/setup-opencode` has one required `version` input with no default.
- The Action supports Linux and macOS x64 and arm64 release assets.
- Unsupported platform pairs fail before cache access and download.
- The Action downloads only the exact official release asset for the request.
- The archive digest matches upstream-published SHA-256 metadata before use.
- Every restored or downloaded executable reports exactly the requested version.
- The Action outputs one absolute verified executable path.
- The exact cache key contains the schema, runner OS, runner architecture,
  and requested version, with no restore-key fallback.
- Cache failures do not alter setup behavior or select another version.
- Corrupt cache data is ignored and an exact fresh download is attempted.
- The cache contains only the verified installation directory.
- The Setup Action uses Node 24, `@actions/tool-cache`, and bundled runtime
  dependencies.
- The Server Action remains lifecycle-only and requires an explicit executable.
- The review workflow uses the Setup Action and has no inline installer.
- The review workflow passes the setup output to the Server Action.
- OpenCode configuration and credentials remain workflow-owned.
- Focused tests, bundle-loading checks, documentation checks, and diff checks pass.

## Traceability

- Packaging: [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)

- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md)
- [task.add-opencode-tool-setup-action](../tasks/2026-09-08-add-opencode-tool-setup-action.md)
- [task.require-explicit-opencode-server-executable](../tasks/2026-09-08-require-explicit-opencode-server-executable.md)
- [task.adopt-opencode-tool-setup-in-review-workflow](../tasks/2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md)
