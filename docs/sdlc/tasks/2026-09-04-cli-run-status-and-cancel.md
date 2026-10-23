---
id: task.cli-run-status-and-cancel
title: Run, Inspect, and Cancel Through the Operational Host
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Run, Inspect, and Cancel Through the Operational Host

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Complete the CLI run-control contract against authoritative Seqlane run state.

## Current replacement

This later task owns replacement work. It was not an original prerequisite.

- [task.effect-v4-hosted-history-and-inspection](./2026-10-21-effect-v4-hosted-history-and-inspection.md)

## Delivery

- Stack order: 17
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

The later [CLI contract](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-cli) and [hosted operations contract](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-hosted-operations) own retained behavior. They do not describe the original integration mechanism.

## Scope

- Add validated run submission and control operations for the local operational host.
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
3. Connect run supervision to the validated control operation.
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
- Status reports active and terminal authoritative Seqlane state.
- Repeated cancel requests produce one cancelled run outcome.
- `SIGINT` and explicit cancel use the same operation.
- An unknown run ID returns a typed, stable failure.
- Transport data is validated before rendering.
- Human, CI, and JSON output keep their stable exit behavior.

## Completion criteria

The CLI can start, observe, and cancel one Seqlane run without owning canonical
runtime state.

## Outcome

The original implementation added a validated operational client, status and cancellation commands, and identity output.
It preserved progress rendering and stable exit handling. It closed resources owned by the command.

The current contract separates standalone execution from the explicit host. Standalone execution creates no Seqlane listener or retained history. The later hosted contract owns status, result, event, and cancellation inspection.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [prd.seqlane-runtime](../prd/2026-10-21-seqlane-runtime.md)
- [rfc.effect-v4-migration](../rfcs/2026-10-21-effect-v4-migration.md)
