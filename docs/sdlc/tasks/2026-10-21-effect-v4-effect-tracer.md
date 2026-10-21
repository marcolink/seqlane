---
id: task.effect-v4-effect-tracer
title: Execute the tracer
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-authority-and-baseline
supersedes: []
---

# Execute the tracer

## Objective

Run one deterministic workflow through the real CLI worker and an Effect scope, with complete output and confirmed process cleanup.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement the minimal deterministic CLI path and process ownership under the active target specification. The tracer definition below is the acceptance path for S1.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Tracer matrix

| Stage                  | Required behavior                                                                                                                     | Evidence                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Oclif command          | Parse the existing command and launch the supervised worker.                                                                          | Compiled CLI invocation preserves help, input, and exit conventions.                                   |
| Worker boundary        | Load the workflow and validate its Plan with the existing Zod contracts.                                                              | Valid workflow starts; malformed definition fails before execution.                                    |
| Effect run scope       | Run one deterministic `shell()` task without constructing an agent or calling a model.                                                | Exact task output and zero model/agent calls.                                                          |
| Process ownership      | Execute argv with explicit cwd/environment and bounded output; settle cancellation only after owned-process termination is confirmed. | Success, nonzero exit, timeout, SIGINT, SIGTERM, and supervisor disconnect leave no owned child alive. |
| Canonical event bridge | Deliver ordered protocol events and exactly one terminal outcome through runner IPC.                                                  | Round-trip values and terminal result match the existing protocol contract.                            |
| CLI output and cleanup | Render the existing human/CI/JSON result after scope cleanup.                                                                         | Output and exit code match baseline; no retained state or cleanup leak.                                |

## Implementation plan

- Add exact checked Effect dependencies only where this path needs them.
- Verify Node platform exports, installed declarations, and Snyk status for each selected package/version before installation.
- Implement run scope, minimal Plan execution, process ownership, and canonical event delivery through the real CLI worker path.
- Keep process-tree behavior explicit; prove external termination rather than relying on fiber interruption.

## Affected areas

`apps/cli/src/commands/run.ts`, `runner-client.ts`, `libs/runtime/src/runner/run.ts`, local task execution, and the event bridge.

## Verification

Verify every tracer-matrix row, package consumption outside the checkout, and observed resource/terminal cleanup.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the superseded local process implementation once all local callers use the verified replacement.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-authority-and-baseline: prerequisite task](./2026-10-21-effect-v4-authority-and-baseline.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
