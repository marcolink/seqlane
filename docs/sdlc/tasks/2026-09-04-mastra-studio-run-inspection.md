---
id: task.mastra-studio-run-inspection
title: Inspect Seqlane Runs in Mastra Community Studio
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-07
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Inspect Seqlane Runs in Mastra Community Studio

## Objective

Connect Community Studio to a working Seqlane/Mastra host and its real runs.

## Dependencies

- [task.cli-run-status-and-cancel](./2026-09-04-cli-run-status-and-cancel.md)
- [task.mastra-mcp-transports](./2026-09-04-mastra-mcp-transports.md)

## Delivery

- Stack order: 19
- Branch: `mastra-19-studio-run-inspection`
- Pull request base: `mastra-18-mcp-transports`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-community-studio`
- `requirement-local-operational-access`
- `requirement-storage-tracing`
- `requirement-cross-surface-run`

## Scope

- Make `seqlane studio` the primary one-command local inspection workflow.
- In its default mode, start and supervise one owned operational host at
  `127.0.0.1:4111`, then start Community Studio at `127.0.0.1:3000`.
- Accept `--server-url <loopback-url>` to attach Community Studio to an
  external host. Validate the URL and never start, replace, or stop that host.
- Keep `seqlane serve` headless. A `serve --studio` alias is out of scope;
  it may be added later only as a thin delegation to the same lifecycle.
- Treat this as one command with two processes, not an embedded Studio or a
  single combined server.
- Wait for host readiness before Community Studio starts.
- Print the host and Studio URLs.
- Stop only the host and Studio processes owned by the command.
- Expose Seqlane workflow, Work, Run, Invocation, task, and Plan metadata.
- Show run state, step executions, and traces from canonical Mastra storage.
- Add process failure and signal handling for both ownership modes.

## Out of scope

- A dedicated, forked, embedded, or rebranded Studio.
- Studio-specific copies of events, run state, or traces.
- Remote authentication, authorization, or hosted Studio deployment.
- Restoring the removed Seqlane recording replay interface.

## Implementation plan

1. Extract a reusable owned-host lifecycle from the foreground `serve` path.
2. Make `studio` use that lifecycle by default and attach-only mode for
   `--server-url`.
3. Add readiness checks and clear startup failures before spawning Studio.
4. Stop owned children on Studio failure and on `SIGINT` or `SIGTERM`; preserve
   attached hosts.
5. Add supported Seqlane metadata to Mastra runs and steps.
6. Add process ownership, signal, and same-run inspection tests.
7. Update the local Studio runbook with both command forms.

## Affected areas

- `apps/seqlane-cli` Studio command
- `libs/seqlane-runtime` metadata registration
- Community Studio integration tests
- Studio documentation

## Verification

- The default command starts one host and one Community Studio process.
- External-host mode does not stop or replace that host.
- `seqlane serve` starts no Community Studio process.
- Studio lists the discovered Seqlane workflows.
- A CLI-started run appears with the same Work and Run identifiers.
- An MCP-started run appears with the same Work and Run identifiers.
- Studio displays task steps and trace correlation metadata.
- Shutdown leaves no owned child process running.

## Completion criteria

`seqlane studio` opens Community Studio against a live Seqlane/Mastra host and
shows the same runs that CLI and MCP clients started.

## Outcome

`seqlane studio` now starts and supervises an owned loopback operational host
by default, waits for readiness, then launches the pinned upstream Mastra
Community Studio. `--server-url` attaches to a validated loopback host without
owning or stopping it. Studio failure and process signals close only the owned
host and Studio processes. `seqlane serve` reuses the owned-host startup path
and remains headless.

The CLI README documents both modes. Command-level coverage proves ownership,
readiness, attach mode, Studio startup failure, signal forwarding, and cleanup.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-community-studio](./2026-09-03-mastra-community-studio.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
