---
id: adr.local-mastra-operational-host
title: Run Seqlane Through a Local Mastra Operational Host
status: accepted
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - rfc.mastra-runtime-and-operational-foundation
supersedes:
  - adr.dedicated-runner-process
  - adr.local-read-only-execution-studio
  - adr.local-development-studio-trust-and-lifecycle
  - adr.studio-vite-development-and-isolated-replay
---

# Run Seqlane Through a Local Mastra Operational Host

## Context

The previous runner and Studio decisions assumed that every run owns a fresh
runtime and that Studio receives a forwarded, in-memory event copy. Mastra now
owns workflow execution, canonical run state, storage, tracing, server routes,
MCP, and Community Studio integration. Those earlier ownership models would
create competing state stores and server lifecycles.

Seqlane needs one local operational surface for workflow discovery, execution,
inspection, cancellation, MCP, and Community Studio. It must not become a
remote or multi-user service without an explicit authentication decision.

## Decision

`seqlane serve` runs one foreground Mastra operational host. The host owns
workflow registration, Mastra server routes, MCP infrastructure, canonical
storage, and tracing for its lifetime.

The host binds only to loopback. Commands that accept an existing host URL must
accept only `localhost`, `127.0.0.1`, or `[::1]` hosts and reject every other
hostname or address before connecting. Remote deployment, authentication,
authorization, and multi-user operation remain out of scope.

`seqlane run` and `seqlane studio` may connect to an existing local host or
launch one that they supervise for their command lifetime. Supervision does not
make the CLI or child process the runtime owner: the host owns every Mastra
execution and its canonical operational state. A host can serve multiple runs
while it is alive.

Run, storage, trace, and discovery bounds are mandatory operational contracts.
Their exact schemas, defaults, cleanup behavior, and verification are delivered
by dedicated tasks before the durable host is implemented.

## Alternatives considered

### Fresh runner process for every run

This isolates each run, but duplicates Mastra lifecycle, registration, and
operational state. It cannot provide one canonical local server and storage
surface.

### Seqlane-owned Studio service and event forwarding

This creates a second server and a non-canonical copy of run state. Upstream
Mastra Community Studio can inspect the host's canonical state directly.

### Remote or network-accessible host

This requires authentication, authorization, tenant isolation, and an
operational deployment model. Those decisions are intentionally deferred.

## Consequences

- CLI, MCP, and Community Studio observe the same stored Mastra run.
- All unauthenticated operational traffic is restricted to loopback.
- The CLI may supervise a host but never owns a second scheduler, run store, or
  trace store.
- Storage retention and discovery capacity become explicit, testable limits.
- The dedicated-runner and Seqlane Studio architecture is retired.

## Traceability

- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [adr.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
