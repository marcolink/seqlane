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
| `version` | `0.4.0` | Repository trust-table version, currently `0.4.0`; optional leading `v` |
| `listen` | `127.0.0.1:7998` | IPv4 literal or `localhost`, with port `1` through `65535` |
| `top-k` | `200` | Non-negative integer |
| `stable-order` | `true` | Boolean; `false` adds `--no-stable` |
| `redact` | `true` | Boolean; `false` adds `--no-redact` |
| `mcp-token` | unset | Optional secret seed for the per-run bearer token |
| `allow-remote-edits` | `false` | Boolean; `true` adds `--allow-remote-edits` and requires a token |
| `startup-timeout-seconds` | `30` | Positive integer from 1 through 600 |

Boolean inputs accept only `true` or `false`, without silently accepting other
values. The Action marks both the optional seed and generated per-run token
with the Actions Toolkit secret mask. A non-loopback listener also requires a
seed.

### requirement-outputs

The Action emits `mcp-url`, `log-path`, `binary-path`, normalized `version`, and
the secret per-run `mcp-token` output.
The MCP URL is `http://<canonical-host>:<canonical-port>/mcp`.

### requirement-release

The Action maps only these runner targets to the repository trust table for
Ripwire `0.4.0`: Linux x64, Linux arm64, macOS x64, and macOS arm64. It
constructs direct URLs under the exact `v<version>` release tag for both
`<asset>.tar.gz` and the matching `<asset>.tar.gz.sha256` file. It applies a
request timeout and maximum byte limits to both downloads. It verifies the
downloaded upstream checksum and the repository-controlled SHA-256 digest
before extraction. Other release versions and targets are rejected.

The archive must use the expected version/platform/architecture root directory,
contain a regular `ripwire` member, and contain no symlinks, hard links,
unsupported tar members, absolute paths, or parent traversal. The Action
extracts only that binary member, sets executable permissions, and verifies that
`ripwire --version` reports the requested version. It never runs the upstream
install script. The version check uses the explicit child environment
allowlist; it does not inherit credentials, Action inputs, Node loader
variables, or other ambient secret variables.

### requirement-service

The Action starts this argument sequence from the trusted install directory:

```text
ripwire <working-directory> --listen=<canonical> --top-k=<n>
```

It adds `--no-stable`, `--no-redact`, and `--allow-remote-edits` only when the
corresponding options are false or enabled. The binary directory is prepended
to `PATH`. Each run creates a new bearer token. If the optional `mcp-token`
input is set, the input is a secret seed for an HMAC derivation with a random
nonce. The seed is never sent to Ripwire. The derived token is passed only as
`RIPWIRE_MCP_TOKEN` in the child environment and is used for readiness; it is
not an argument. The Action masks both values and publishes only the derived
token as the secret `mcp-token` output. The child environment removes the raw
`INPUT_MCP-TOKEN` Action variable.

Before readiness, the Action persists one JSON `service-state` value with the
process and sentinel identities through `@seqlane/action-service-lifecycle`.
The value is validated by a Zod schema. State-save failure and readiness
failure both attempt identity-checked process-group cleanup.

### requirement-readiness

Readiness posts a JSON-RPC MCP initialize request to `/mcp` with `Accept:
application/json, text/event-stream` and `Content-Type: application/json`.
When configured, it sends `Authorization: Bearer <token>`. A successful probe
requires HTTP 200 and a JSON-RPC 2.0 response with the matching request ID,
the exact requested protocol version, `serverInfo.name` equal to `ripwire`,
and the expected Ripwire server software version (`1.0`). The server software
version is separate from the downloaded release version. JSON and one-event
SSE responses are accepted. One startup deadline is shared by all probes. Each
probe receives the remaining time, caps its request timeout to that time, and
the caller checks the deadline again after the probe. The probe has bounded
response size and cancels the response body during cleanup.

Before spawn, the Action checks that the canonical listen port is available.
The check is an early failure signal, not an ownership proof. During each
startup probe, the Action opens one unauthenticated TCP connection to the
canonical listener. It uses `/usr/bin/ss` on Linux and `/usr/sbin/lsof` on
macOS to verify that a listening PID belongs to the spawned process group. It
keeps the connection open during this check, then sends the MCP request and
bearer token over the same connection. It does not send request bytes or the
token before ownership is verified. The ownership command uses the probe's
remaining timeout and a bounded output buffer. An unrelated listener cannot
satisfy readiness.

After readiness, the Action verifies that the spawned process is alive and
still has the recorded process identity. A failed check uses the same startup
cleanup helper as readiness and state-save failures. That helper warns when
identity-checked termination returns false or throws.

The startup timeout in milliseconds must be a safe integer from 1 through
600000. The wait loop and every probe reject values outside that range before
starting work.

### requirement-cleanup

The post entrypoint reads and validates the single persisted service state and
asks the shared lifecycle library to terminate the matching process group. It
warns when the group cannot be verified or stopped and never signals a reused
process group. Without valid service state or a validated cleanup-only marker,
post does not remove the install directory. After successful termination, it
removes the persisted install directory. If acquisition fails, the partial
install directory is removed immediately. If partial-install removal fails,
acquisition raises a typed error that preserves the original cause and carries
the install path and cleanup error. Main warns about the cleanup error and
persists the install path with a validated cleanup-only marker. It propagates
the typed install error with the original acquisition error as its cause and
message. Post removes that path only when the marker is present. A startup
failure removes the install directory only when no process was spawned or
identity-checked cleanup succeeded; otherwise post cleanup retains ownership.
Lifecycle startup failures use a typed error with a `cleanupSucceeded` field so
main can make this decision without guessing from the error message. If spawn
rejects after creating an anchor, the shared lifecycle library waits for the
anchor and observes the process group exit. When process identity is available,
it also uses identity-checked process-group termination. It wraps the rejection
in a typed `SpawnDetachedError` with the verified `cleanupSucceeded` result and
any validated primary or sentinel ownership. If cleanup is not verified, the
Action persists that ownership in `service-state` for post-job retry. If spawn
rejects before returning a validated `DetachedProcess`, the Action reports
`cleanupSucceeded=false` without inventing an identity. Post cannot safely
retry without validated ownership, so the install remains for runner-level
cleanup.

The child environment is an explicit allowlist containing the trusted binary
`PATH`, temporary and home paths, locale values, XDG paths, and the optional
`RIPWIRE_MCP_TOKEN`. Action inputs, GitHub tokens, cloud credentials, and
other ambient variables are not inherited.

### requirement-review-workflow-caller

The trusted `.github/workflows/seqlane-code-review.yml` caller starts both the
existing `actions/zvec-grep-server` Action and `actions/ripwire-server` against
`${{ github.workspace }}/review-target`. It starts Ripwire after zvec-grep and
supplies `version: 0.4.0`, `listen: 127.0.0.1:7998`, `top-k: 200`,
`stable-order: true`, `redact: true`, `allow-remote-edits: false`, and
`startup-timeout-seconds: 30`. It does not supply an `mcp-token` seed. It uses
Ripwire's generated `mcp-url` and per-run `mcp-token` outputs to configure a
second authenticated remote MCP server in OpenCode.

The caller keeps the existing zvec MCP configuration and permission. OpenCode
keeps `*` denied and explicitly allows all Ripwire read-only tools:
`ripwire_analyze`, `ripwire_find_symbol`, `ripwire_find_referencing_symbols`,
`ripwire_grep`, `ripwire_cochange`, `ripwire_memory_recall`,
`ripwire_situational_awareness`, `ripwire_mentions`, `ripwire_for`,
`ripwire_lego`, `ripwire_owners`, `ripwire_fetch_body`, `ripwire_batch`,
`ripwire_exemplar`, `ripwire_quality_delta`, `ripwire_impact`, `ripwire_uses`,
`ripwire_path_between`, `ripwire_connect`, `ripwire_explore`,
`ripwire_from_trace`, `ripwire_edit_check`, `ripwire_whereis`,
`ripwire_stray_content`, `ripwire_flags`, `ripwire_doc_drift`, and
`ripwire_slice`. The write-capable tools `ripwire_quality_baseline`,
`ripwire_replace_symbol_body`, `ripwire_insert_before_symbol`, and
`ripwire_insert_after_symbol` remain denied by the default policy. The
generated Ripwire token is added as a second newline-delimited redaction value
where the workflow processes or exports the review recording. The workflow
continues to use trusted workflow/source checkouts and does not execute
untrusted pull-request code.

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
- The review workflow starts zvec-grep and Ripwire against `review-target`,
  uses Ripwire's generated URL and token, keeps remote edits disabled, and
  adds all Ripwire read-only tools to the OpenCode allowlist while the four
  write-capable tools remain denied.

## Traceability

- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [task.migrate-service-actions-to-workspace-structure](../tasks/2026-09-07-migrate-service-actions-to-workspace-structure.md)
- [task.add-ripwire-server-action](../tasks/2026-09-08-add-ripwire-server-action.md)
- [task.adopt-ripwire-in-code-review](../tasks/2026-09-08-adopt-ripwire-in-code-review.md)
- [spec.zvec-grep-action-owned-indexing](2026-09-07-zvec-grep-action-owned-indexing.md)
