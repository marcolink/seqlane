---
id: task.mastra-studio-run-inspection
title: Inspect Seqlane Runs in Mastra Community Studio
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
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

- Stack order: 17
- Branch: `mastra-17-studio-run-inspection`
- Pull request base: `mastra-16-mcp-transports`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-community-studio`
- `requirement-storage-tracing`
- `requirement-cross-surface-run`

## Scope

- Start an owned operational host when no external server URL is set.
- Connect to an external host when its URL is set.
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

1. Add an owned-host lifecycle to the existing Studio launcher.
2. Add readiness checks and clear startup failures.
3. Connect Studio to the resolved operational server URL.
4. Add supported Seqlane metadata to Mastra runs and steps.
5. Add process ownership, signal, and same-run inspection tests.
6. Update the local Studio runbook.

## Affected areas

- `apps/seqlane-cli` Studio command
- `libs/seqlane-runtime` metadata registration
- Community Studio integration tests
- Studio documentation

## Verification

- The default command starts one host and one Community Studio process.
- External-host mode does not stop or replace that host.
- Studio lists the discovered Seqlane workflows.
- A CLI-started run appears with the same Work and Run identifiers.
- An MCP-started run appears with the same Work and Run identifiers.
- Studio displays task steps and trace correlation metadata.
- Shutdown leaves no owned child process running.

## Completion criteria

`seqlane studio` opens Community Studio against a live Seqlane/Mastra host and
shows the same runs that CLI and MCP clients started.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-community-studio](./2026-09-03-mastra-community-studio.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
