---
id: spec.ripwire-server-action
title: Ripwire HTTP MCP GitHub Action
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - adr.seqlane-action-library-boundary
  - task.migrate-service-actions-to-workspace-structure
supersedes: []
---

# Ripwire HTTP MCP GitHub Action

## Summary

The workspace provides a self-maintained JavaScript Action at
`actions/ripwire-server`. The Action downloads one exact Ripwire GitHub Release
asset, verifies it, starts the HTTP MCP service for one workspace, waits for a
valid MCP initialize response, and stops the service after the job.

## Goals

- Provide a reproducible Ripwire binary for supported GitHub-hosted runners.
- Keep the Action contract small, secure by default, and independent of the
  upstream install script.
- Use the existing identity-checked detached-process lifecycle.
- Make acquisition, validation, command construction, readiness, and cleanup
  independently testable.

## Non-goals

- Changing the Ripwire binary or MCP protocol.
- Supporting unsupported operating systems or architectures.
- Running the upstream install script or a third-party setup Action.
- Adopting the Action in `.github/workflows/seqlane-code-review.yml`; that is
  a later change and is out of scope for this specification.

## Terminology

- **Release version**: a numeric `X.Y.Z` version, optionally entered with a
  leading `v`.
- **Loopback**: `localhost` or `127.0.0.1`.
- **Install directory**: a directory under `RUNNER_TEMP` that contains the
  verified `ripwire` executable.

## Requirements

### requirement-inputs

The Action requires `working-directory`. It accepts these optional inputs:

| Input | Default | Contract |
| --- | --- | --- |
| `version` | `0.4.0` | `X.Y.Z`, with optional leading `v`; output is numeric `X.Y.Z` |
| `listen` | `127.0.0.1:7998` | IPv4 literal or `localhost`, with port `1` through `65535` |
| `top-k` | `200` | Non-negative integer |
| `stable-order` | `true` | Boolean; `false` adds `--no-stable` |
| `redact` | `true` | Boolean; `false` adds `--no-redact` |
| `mcp-token` | unset | Optional secret bearer token |
| `allow-remote-edits` | `false` | Boolean; `true` adds `--allow-remote-edits` and requires a token |
| `startup-timeout-seconds` | `30` | Positive integer |

Boolean inputs accept only `true` or `false`, without silently accepting other
values. The Action marks a configured token with the Actions Toolkit secret
mask. A non-loopback listener also requires a token.

### requirement-outputs

The Action emits `mcp-url`, `log-path`, `binary-path`, and normalized `version`.
The MCP URL is `http://<canonical-host>:<canonical-port>/mcp`.

### requirement-release

The Action maps only these runner targets to release assets: Linux x64, Linux
arm64, macOS x64, and macOS arm64. It constructs direct URLs under the exact
`v<version>` release tag for both `<asset>.tar.gz` and the matching
`<asset>.tar.gz.sha256` file. It applies a request timeout and maximum byte
limits to both downloads. It verifies the SHA-256 digest before extraction.

The archive must use the expected version/platform/architecture root directory,
contain a regular `ripwire` member, and contain no symlinks, hard links,
unsupported tar members, absolute paths, or parent traversal. The Action
extracts only that binary member, sets executable permissions, and verifies that
`ripwire --version` reports the requested version. It never runs the upstream
install script.

### requirement-service

The Action starts this argument sequence from the trusted install directory:

```text
ripwire <working-directory> --listen=<canonical> --top-k=<n>
```

It adds `--no-stable`, `--no-redact`, and `--allow-remote-edits` only when the
corresponding options are false or enabled. The binary directory is prepended
to `PATH`. A configured token is passed only as `RIPWIRE_MCP_TOKEN` in the
child environment; it is not an argument. The child environment removes the
raw `INPUT_MCP-TOKEN` Action variable.

Before readiness, the Action persists all six process and sentinel identity
state fields through `@seqlane/action-service-lifecycle`. State-save failure
and readiness failure both attempt identity-checked process-group cleanup.

### requirement-readiness

Readiness posts a JSON-RPC MCP initialize request to `/mcp` with `Accept:
application/json, text/event-stream` and `Content-Type: application/json`.
When configured, it sends `Authorization: Bearer <token>`. A successful probe
requires HTTP 200 and a JSON-RPC 2.0 response with the matching request ID,
protocol version, capabilities, and server information. JSON and one-event SSE
responses are accepted. The probe has bounded response size and cancels the
response body during cleanup.

### requirement-cleanup

The post entrypoint reads the persisted identities and asks the shared
lifecycle library to terminate the matching process group. It warns when the
group cannot be verified or stopped and never signals a reused process group.

## Failure and edge cases

- Invalid input fails before download or process spawn.
- An unsupported runner target, missing release asset, timeout, size bound,
  checksum mismatch, invalid archive, or binary version mismatch fails before
  service spawn.
- A missing or non-directory workspace fails before download and spawn.
- Missing authentication for a routable bind or remote edits is rejected.
- A non-200 or malformed initialize response causes cleanup and Action failure.
- The default is loopback, redacted, stable, and read-only.

## Verification

Unit tests cover input and security validation, asset mapping, bounded
downloads, checksums, archive safety, version checks, exact command and
environment construction, readiness headers and JSON-RPC validation, lifecycle
ordering and cleanup, process-anchor resolution, bundle loading, and the
GitHub-hosted smoke job.

## Acceptance criteria

- The Action is a self-contained committed ESM bundle with a separate post
  bundle and process anchor.
- It installs only a verified Ripwire binary from a direct versioned release
  URL for a supported target.
- It starts, probes, exposes outputs, and cleans up the service as specified.
- All input and token security combinations are tested.
- `.github/workflows/unit-tests.yml` runs a read-only hosted smoke job.
- `.github/workflows/seqlane-code-review.yml` is unchanged by this work.

## Traceability

- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md)
- [task.add-ripwire-server-action](../tasks/2026-09-08-add-ripwire-server-action.md)
