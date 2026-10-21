---
id: task.effect-v4-hosted-history-and-inspection
title: Hosted history, HTTP, MCP, and inspection
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-cli-and-action-cutover
supersedes: []
---

# Hosted history, HTTP, MCP, and inspection

## Objective

Connect one real hosted workflow from HTTP start to events/result/cancel, SQL history, and trace inspection after restart.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Connect one real hosted workflow from HTTP start to events/result/cancel, SQL history, and trace inspection after restart.
- Implement protocol-owned Zod DTOs and migrate every consumed operational-client operation.
- Use Effect HTTP/SQL/MCP primitives with the same run program and composition-owned adapters.
- Prove the same run path through MCP, including protocol negotiation, admission bounds, and client cancellation.
- Remove `unstable_studio` only after these inspection paths work. Document TUI, replay, host inspection, and optional telemetry viewers.

## Affected areas

`libs/runtime/src/operational-host.ts`, host implementation, protocol DTOs, CLI operational client, and `unstable_serve`.

## Verification

host restart inspection, interrupted-run handling, health/readiness, loopback/origin checks, storage failure, trace flush, and MCP integration.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old host/server/storage composition, Studio launcher, and newly unused dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-cli-and-action-cutover: prerequisite task](./2026-10-21-effect-v4-cli-and-action-cutover.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
