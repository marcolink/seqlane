---
id: task.cli-run-status-and-cancel
title: Run, Inspect, and Cancel Through the Operational Host
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Run, Inspect, and Cancel Through the Operational Host

## Objective

Complete the CLI run-control contract against canonical Mastra run state.

## Dependencies

- [task.mastra-operational-host](./2026-09-04-mastra-operational-host.md)

## Delivery

- Stack order: 15
- Branch: `mastra-15-cli-run-control`
- Pull request base: `mastra-14-operational-host`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-cli-operator-commands`
- `requirement-cancellation-errors`
- `requirement-identity-events`
- `requirement-cross-surface-run`

## Scope

- Submit `seqlane run` through the operational server path.
- Support an explicit external server URL.
- Own a loopback host for the command lifetime when no server URL is set.
- Print Work and Run identifiers before progress output.
- Preserve human, CI, and JSON rendering and final exit statuses.
- Add `seqlane status <run-id>` with human and JSON output.
- Add `seqlane cancel <run-id>` with an idempotent result.
- Route foreground `SIGINT` through the same cancellation operation.
- Normalize server, transport, missing-run, and cancellation failures.

## Out of scope

- Detached run submission or background job management.
- Remote authentication or authorization.
- Retry, resume, or mutation of completed runs.
- A second CLI-owned run or trace store.

## Implementation plan

1. Define Zod schemas for CLI and server request boundaries.
2. Add a private operational client for run, status, and cancel operations.
3. Switch run supervision to the operational server path.
4. Add status and cancel commands.
5. Preserve output and exit contracts at the CLI boundary.
6. Delete the replaced direct-only control path after callers switch.

## Affected areas

- `apps/seqlane-cli`
- private runner and server integration modules
- `libs/seqlane-core` stable request and result schemas
- CLI documentation

## Verification

- Run prints one Work ID and Run ID before task progress.
- Status reports active and terminal canonical Mastra state.
- Repeated cancel requests produce one cancelled run outcome.
- `SIGINT` and explicit cancel use the same operation.
- An unknown run ID returns a typed, stable failure.
- Transport data is validated before rendering.
- Human, CI, and JSON output keep their stable exit behavior.

## Completion criteria

The CLI can start, observe, and cancel one Mastra run without owning canonical
runtime state.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
