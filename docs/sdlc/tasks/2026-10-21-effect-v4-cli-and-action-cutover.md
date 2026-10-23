---
id: task.effect-v4-cli-and-action-cutover
title: CLI and direct Action cutover
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-telemetry-and-event-pressure
supersedes: []
---

# CLI and direct Action cutover

## Objective

Make the common Effect program the sole execution path for `run`, `startWorkflowRun`, workflow packages, and Action workflow callers.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Make the common Effect program the sole execution path for `run`, `startWorkflowRun`, workflow packages, and Action workflow callers.
- Migrate plan/replay orchestration while preserving their contracts.
- Remove temporary test composition, runtime selectors, old direct entrypoints, duplicate cancellation handlers, and compatibility bridges.
- This slice can ship only after S1–S8 establish parity. Hosted callers still require S10 before final engine deletion.

## Affected areas

`apps/cli`, `libs/runtime` exports, both workflow Action libraries, and all three `workflows/*` packages.

## Verification

compiled CLI outside the checkout, input/import/output matrix, direct Action integration, no standalone disk state, and public Zod/API parity.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the old engine-specific path after its callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Implementation follows S8 commit `e03397b`. CLI runs, direct workflow calls, and both workflow Action callers select the same native Effect Plan program. Oclif parsing, public Zod contracts, execution-event version, and final JSON output remain unchanged.

```ts
// Before: a caller selected the private program.
startWorkflowRun(request, { program: createEffectPlanProgram });
// After: the facade owns the sole program.
startWorkflowRun(request);
```

Plan and replay orchestration use Effect. The old production compiled-run entrypoints, program selectors, Promise graph lifecycle, worker tracer bridge, and unused operational-host run helper are removed. Lower-level test facades delegate to the same graph program. They provide no alternate scheduler or production selector.

Both workflow Action callers forward canonical observations. The conflict-resolution runner owns adapter acquisition through attempt settlement, rejects overlapping attempts, and drains acquisition before stopping its shared service. Focused lifecycle regressions cover startup, cancellation, retrying cleanup, and exact primitive cleanup causes.

The private ownership channel validates and acknowledges process records before SDK protocol work. Runtime and native adapters share one private OS identity implementation in `@seqlane/agent-adapter`. The CLI rechecks birth identity before forced cleanup. Registration and release have finite native deadlines. The supervisor bounds queued and in-flight IPC bytes, checks monotonic shutdown deadlines before taking more messages, and waits for confirmed worker exit. Accepted terminal events still wait for the close event. A processed IPC disconnect and confirmed exit settle failed supervision after owned-process cleanup. User signals select status `130`; infrastructure failures select status `1`.

Codex app-servers now own detached POSIX groups. Native process tests stop a resistant parent and grandchild while preserving a foreign sentinel. A separate regression verifies that a lost leader identity cannot authorize a signal to its remaining group. Cleanup uncertainty remains visible, including failed initialization. The same identity helper refuses to claim Windows descendant shutdown without proof.

Root heartbeat failure cancels and drains the graph. Task deadlines begin at execution rather than admission. Workflow-input errors have a private origin marker, so a task with the same ID retains its typed input error and original Zod cause.

### Verification state

The latest full repository gate passes frozen installation, documentation validation, all 537 test mappings, complete typechecking, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 677 runtime tests and 135 CLI unit tests pass.

The complete compiled CLI suite passes 116 tests across nine files in 142.45 seconds. One duplicate Codex parameter for the OpenCode-specific trace proof is skipped. The suite proves real Codex ownership, resistant ACP cleanup, foreign-process survival, classifier trace correlation, output modes, malformed input, noisy IPC deadlines, repeated signals, failed sinks, and supervisor disconnect. The disconnect proof reaches its process marker, disconnects IPC, and confirms both child shutdown and worker exit. Later disconnect and exit events preserve the original sink cause. FIFO ordering retains a terminal message received between exit and disconnect. Both gates pass on frozen source with Node 24.16.0 and one test worker.

Structural review covers all 144 quality-delta rows, including 67 gating findings. The remaining findings reflect shared lifecycle state, bounded native interop, small result constructors, test mocks, and churn. The Codex shutdown branch has depth three. Two bounded cohesion passes separate process supervision and inbox admission. No baseline or acknowledgement files change, and no zero-debt claim is made. The test map selects 75 suites; its static untested callback radius is reviewed alongside native integration evidence.

Process identity evidence runs on macOS. No Windows execution, new paid-provider result, or remote CI result is claimed. Hosted replacement, distribution, and complete removal remain S10–S12 work.

## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: document private process ownership records and verified supervisor cleanup; preserve public and execution-event wire behavior.
- TASK: record sole-program caller evidence, application lifetimes, deadline ownership, cleanup, and removed bridges.
- ADR required: no

### Rationale

The active target contract already requires one Effect program for all callers, Oclif parsing, public Zod contracts, and bounded external cleanup. S1–S8 establish the implementation and parity evidence. S9 makes those services the production path and removes the replaced caller paths. Detached adapter processes require a private validated ownership record so the CLI can verify native cleanup after a worker stops responding. This record carries process identity, not adapter implementation or workflow authoring state.

### Required work

Keep runtime, CLI, workflow, and Action documentation aligned. Prove direct Action execution and installed CLI behavior, including default workspace, malformed input, cancellation, failed sinks, supervisor loss, and second interruption. Preserve canonical observations and real parent correlation. Leave hosted storage, server, and inspection replacement to S10.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S8 commit `e03397b`. Evidence is branch-local. Hosted replacement remains S10 work; remaining Actions, distribution, and complete removal remain S11–S12 work.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-telemetry-and-event-pressure: prerequisite task](./2026-10-21-effect-v4-telemetry-and-event-pressure.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
