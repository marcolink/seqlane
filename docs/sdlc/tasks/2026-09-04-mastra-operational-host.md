---
id: task.mastra-operational-host
title: Add the Durable Mastra Operational Host
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Add the Durable Mastra Operational Host

## Objective

Run registered Seqlane workflows through one durable Mastra server process.

## Dependencies

- [task.workflow-discovery-and-plan-cli](./2026-09-04-workflow-discovery-and-plan-cli.md)

## Delivery

- Stack order: 14
- Branch: `mastra-14-operational-host`
- Pull request base: `mastra-13-workflow-discovery-plan`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-operational-host`
- `requirement-storage-tracing`
- `requirement-server-mcp`
- `requirement-community-license`

## Scope

- Add `seqlane serve` as a foreground, loopback-only command.
- Register discovered workflows with one Mastra instance at startup.
- Add a supported Mastra Community server adapter.
- Expose Mastra workflow, run, storage, trace, and MCP routes.
- Replace per-run operational memory storage with a durable Community adapter.
- Resolve one storage configuration for CLI, server, MCP, and Studio use.
- Add readiness output and a health check.
- Stop cleanly on `SIGINT`, `SIGTERM`, or startup failure.
- Keep Mastra server and storage types inside the private integration boundary.

## Out of scope

- Remote deployment, authentication, authorization, or multi-user operation.
- Background daemon management or service installation.
- CLI status and cancellation commands.
- MCP stdio and Studio process orchestration.

## Implementation plan

1. Verify the pinned server adapter and durable storage APIs.
2. Run the required dependency security and license checks.
3. Build one private operational-host composition root.
4. Register discovery results, storage, tracing, and MCP with Mastra.
5. Add the foreground serve command and lifecycle handling.
6. Remove the in-process-only server facade after callers switch.
7. Add host, restart-persistence, and public-boundary tests.

## Affected areas

- `apps/seqlane-cli`
- `libs/seqlane-runtime`
- runtime and CLI package manifests
- local operation documentation

## Verification

- The host binds only to the configured loopback address by default.
- Mastra routes list the registered Seqlane workflows.
- One run remains inspectable after the run process ends.
- A restarted host reads the same run from Mastra storage.
- Readiness occurs only after discovery, storage, and route setup succeed.
- Shutdown flushes tracing and closes server and storage resources.
- No core or public declaration contains a Mastra type.
- No dependency or import crosses the Community license boundary.

## Completion criteria

`seqlane serve` runs one durable Mastra operational host without a competing
Seqlane server or canonical state store.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-storage-tracing](./2026-09-03-mastra-storage-tracing.md)
- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
