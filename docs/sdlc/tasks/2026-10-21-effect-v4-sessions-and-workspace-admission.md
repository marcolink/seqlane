---
id: task.effect-v4-sessions-and-workspace-admission
title: Sessions and workspace admission with real callers
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-dependency-graphs
supersedes: []
---

# Sessions and workspace admission with real callers

## Objective

Run generic adapter fixtures with isolated, shared, checkpoint, and fork behavior plus competing workspace users.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run generic adapter fixtures with isolated, shared, checkpoint, and fork behavior plus competing workspace users.
- Reuse pure lowering rules; implement atomic eligibility and cancellation-aware waiting with Effect primitives.
- Preserve model inheritance, fairness, parent/child admission, background-process tracking, and uncertain-termination quarantine.

## Affected areas

`runtime/session`, `runtime/workspace`, `runtime/invocation`, `runtime/profile`, and `libs/adapter`.

## Verification

Compiled Oclif and direct runtime fixtures verify isolated sessions, reuse, checkpoint forks, model inheritance, and profile cleanup before terminal publication. Generic adapters preserve full canonical observation payloads and contiguous event sequences.

Shared sessions serialize. Compatible workspace users overlap, while conflicting users wait. Eight blocked admission waiters do not consume body permits needed by unrelated work. A workspace waiter does not reserve its session against eligible work in another workspace.

Native fiber interruption removes queued waiters. Running tasks retain session and workspace admission until their SDK cleanup settles. Late uncertainty overrides cancellation, preserves the original executor cause, and quarantines affected resources. Unrelated work can still settle.

All 71 CLI end-to-end tests pass. The full repository gate passes frozen install, documentation validation, 418 test mappings, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. The runtime suite passes all 512 tests.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove replaced queue/lock/timer lifecycle code after all admission callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed native Effect session and workspace admission through the shared Plan program. Deferred waits replace the previous Promise queue lifecycle. Admission completes before a task takes a body permit, and each invocation scope owns its leases.

The target composition resolves its execution profile after workflow input validation. It preserves session capability checks, model preflight, checkpoint lineage, observations, and cleanup ordering. Public and wire Zod contracts remain unchanged.

The Promise lock facades and legacy static workspace ordering remain temporary caller bridges until S9. Production caller cutover is still pending. These generic fixtures do not prove recovery from native adapters that leave SDK Promises or activity tracking unsettled after uncertainty. S5 and S7 own that remaining adapter and deadline work.

Documentation impact is implementation-only. The runtime README and migration delivery records are reconciled. No new ADR or product contract change is required.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit. Evidence is branch-local. No default-branch or remote-CI delivery claim is made.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-dependency-graphs: prerequisite task](./2026-10-21-effect-v4-dependency-graphs.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
