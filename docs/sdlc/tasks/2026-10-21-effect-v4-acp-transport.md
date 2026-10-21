---
id: task.effect-v4-acp-transport
title: ACP without the old transport
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-native-adapters-and-observations
supersedes: []
---

# ACP without the old transport

## Objective

Replace `@mastra/acp` with an exact checked official ACP SDK version.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Replace `@mastra/acp` with an exact checked official ACP SDK version.
- Use the selected version's supported client API, not remembered connection classes.
- Run ACP v1 initialization, model selection, prompt updates, tools, denied interaction, structured-output repair, and cancellation.
- Preserve explicit persistence configuration and report unsupported checkpoint/fork capabilities truthfully.

## Affected areas

`libs/acp/src/adapter.ts`, contracts, stream reducer, output validation, and observation projection.

## Verification

official-protocol subprocess fixture, malformed updates, cancellation/late rejection, and installed-agent smoke evidence where available.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old ACP agent wrappers, engine span projection, and all old ACP dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed after S5 commit `e269696`. Exact official SDK `2.0.0` replaces the old ACP agent wrapper and both old adapter dependencies. Registry metadata, installed declarations, official documentation, and Snyk root and version pages verify the selected version. Effect owns request serialization, update consumption, cancellation, process scopes, and bounded cleanup. Public and wire validation remains Zod-owned.

The adapter initializes ACP v1, selects the exact configured model from advertised options, denies permission requests, and repairs structured output. Persistence remains explicit. Unsupported checkpoint, fork, and dynamic model selection capabilities remain unavailable. Agents without session-close support receive a new process for each nonpersistent execution.

Canonical activity retains complete available native tool snapshots, partial updates, notification metadata, false, zero, empty strings, and null. Context-usage observations retain complete native notifications. Context occupancy and cumulative session cost do not become invented per-call tokens or cost. Malformed native updates fail before the SDK can discard them. Tool terminal events require native prompt completion or confirmed process-tree termination. Cancellation preserves the original abort reason and late SDK failures.

The pinned SDK completed ACP v1 initialization and session creation against installed OpenCode `1.18.27`. The agent advertised one model configuration option. This check sent no model prompt. Full model execution remains unavailable because the preceding native adapter smoke received HTTP 401. This limitation does not establish model execution through ACP.

The complete repository gate passes frozen installation, documentation validation, 506 test mappings, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 39 ACP tests and 554 runtime tests pass. All 93 compiled Oclif and worker tests pass. Native subprocess tests verify permission denial, model preflight, output repair, persistence, complete observations, cancellation, and confirmed process exit before terminal events. Default CLI runs create no Seqlane state directory.

The first gate exposed one unchanged five-second runtime timeout, a test-fixture dependency classification error, and formatting drift. The isolated runtime file passed all 18 tests at unchanged budgets. The complete gate passed with one Nx project and one Vitest worker at a time. CLI assertions now use the physical macOS path and the correct task ID. Real process-access checks pass; sandbox-denied process inspection cannot establish shutdown. Native Windows process-tree cleanup remains unverified on this macOS host.

Structural review separated transport, session lifecycle, prompt execution, and adapter orchestration. Remaining private failure-handling complexity and small test-helper duplication are conscious tradeoffs; no zero-debt claim is made. Telemetry projection remains S8 work. Production Plan and worker cleanup cutover remain S9 work. Hosted observation persistence remains S10 work. Distribution cleanup remains S11–S12 work.

## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: clarify configured model selection and the distinction between ACP context usage and per-call model usage.
- TASK: record native ACP protocol, process ownership, observations, and verification evidence.
- ADR required: no

### Rationale

The active target spec already requires direct ACP SDK ownership with Effect. The selected SDK represents model selection through advertised configuration options. Its context-usage updates expose context occupancy and cumulative session cost. These values must retain their native meaning. Public and wire schemas remain Zod-owned and retain their existing version.

### Required work

Reconcile the adapter README and this task after verification. Remove old wrappers and span projection. Preserve explicit persistence and truthful capability reporting. Record the model-selection protocol boundary. Verify that context usage and cumulative cost are preserved without invented per-call token or cost metrics.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S5 commit `e269696`. Evidence is branch-local. No default-branch, remote-CI, or full migration delivery claim is made. OpenCode live model verification remains unavailable after provider HTTP 401.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-native-adapters-and-observations: prerequisite task](./2026-10-21-effect-v4-native-adapters-and-observations.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
