---
id: spec.adapter-cli-flags
title: Direct-Run Adapter CLI Flags
status: active
owners:
  - core
created: 2026-09-19
updated: 2026-09-19
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Direct-Run Adapter CLI Flags

## Summary

`seqlane run` selects an installed direct-run adapter with `--adapter`. It no
longer accepts `--runtime` or requires `SEQLANE_RUNTIME_ADAPTER_CONFIG`.
This contract changes only run flags and adapter configuration behavior. It
does not select or deliver standalone-execution cutover work.

## Goals

- Make direct-run adapter selection explicit and simple.
- Validate adapter-specific optional flags before child-process startup.
- Keep adapter identity and settings out of workflow source, Plans, and runner
  IPC.
- Preserve hosted command configuration behavior.

## Non-goals

- Workflow loading, runtime-engine, persistence, host, output, or IPC cutover.
- Adapter selection in workflow source or serialized Plans.
- ACP direct-run selection. ACP is a protocol; a concrete harness contract is
  required before it can become a direct-run adapter choice.

## Requirements

### requirement-run-adapter-flags

`run` accepts optional `--adapter <id>`. Supported IDs are `opencode` and
`codex`. A deterministic workflow can omit the flag. An agent task without a
selected adapter fails when it first requires an adapter.

`run` accepts `--adapter-host <host>` and `--adapter-port <port>` only with
`--adapter opencode`. The host must be loopback. The port is an integer from
`0` through `65535`; `0` requests an ephemeral port. Defaults are
`127.0.0.1` and `0`.

`--runtime` is removed without a compatibility alias. Direct runs ignore an
inherited `SEQLANE_RUNTIME_ADAPTER_CONFIG` value.

### requirement-owned-opencode-service

OpenCode host and port values configure one service started and owned by the
run. They do not attach to an existing service. Startup verifies that the
reported endpoint has the requested loopback host and, for a non-zero request,
the requested port. Cleanup affects only the process owned by that run.

### requirement-private-bootstrap

The CLI validates one canonical Zod discriminated adapter-input schema after
Oclif constraint validation. It passes the validated value to its child through
a private, per-run bootstrap channel. This channel is not user configuration,
is not documented, and does not enter runner IPC.

Hosted commands retain their existing configuration contract.

## Verification

- Test valid and invalid adapter/flag combinations through the compiled CLI.
- Prove deterministic and dry runs start no adapter service.
- Prove OpenCode default and requested-port ownership, cancellation, and
  foreign-process survival.
- Prove legacy direct-run flag and environment configuration do not select an
  adapter.
- Run adapter, CLI, test-mapping, documentation, build, and whitespace gates.

## Delivery state

Active implementation contract. No delivery is claimed by this document.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [Cancelled standalone CLI cutover](../tasks/2026-09-16-standalone-cli-cutover.md)
