---
id: task.effect-v4-classifier-and-deadlines
title: Classifier, mixed workflows, and deadlines
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-acp-transport
supersedes: []
---

# Classifier, mixed workflows, and deadlines

## Objective

Run a classifier workflow with deterministic preparation and downstream result consumption through CLI and direct entrypoints.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run a classifier workflow with deterministic preparation and downstream result consumption through CLI and direct entrypoints.
- Move HTTP, retry schedules, clock, and request cleanup to Effect while preserving the classifier contract.
- Preserve private connection handling before workflow import and zero agent acquisition for classifier-only runs.

## Affected areas

`libs/runtime/src/classifier`, private runner configuration, classifier task fixtures, and relevant workflows.

## Verification

fake-clock retry/total-deadline tests plus local HTTP integration for success, malformed results, cancellation, and secret handling.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove replaced manual fetch/retry/timer orchestration without changing question/result semantics.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Implementation follows S6 commit `3434904`. The private classifier client uses the pinned Effect `4.0.5` HTTP client, scoped response streams, native retry schedules, and monotonic clock. The [official HTTP API](https://effect.website/docs/v4/api/effect/http/HttpClient) and installed declarations verify the scoped request boundary. Question/result validation and private connection handling remain unchanged.

One 20-second transport budget covers requests, response reading, validation, observation delivery, and retry waits. Request preparation stays outside that budget. Four attempts remain the maximum. Retryable statuses, strict HTTP-date parsing, backoff, and `Retry-After` keep their existing meaning. A retry that cannot fit the remaining budget stops immediately. Monotonic checks also reject results after synchronous work consumes the budget.

Each attempt owns its HTTP request and response scope. Empty, malformed, oversized, and invalid UTF-8 responses fail without inappropriate retries. Cancellation aborts active response reading. Available safe provider documents and usage remain complete on mapping failure, including false, zero, empty strings, and null. Rejected credential-bearing documents cannot leak through failed response or usage observations. Observation-sink failures retain their original frozen, primitive, null, or undefined value and do not trigger HTTP retries.

Focused tests pass 55 runtime cases, the compiled mixed-workflow CLI case, typechecking, and 509 test mappings. Native `TestClock` evidence verifies a one-second `Retry-After` with only 500 milliseconds remaining. Additional clock tests verify no retry after the deadline and no successful result after synchronous observation delivery exhausts the budget. Local HTTP tests verify response parsing, authorization handling, and peer-observed cancellation. Direct and compiled Oclif callers run deterministic preparation, classifier questions, and deterministic result consumption. The compiled workflow verifies credential removal before import, zero agent acquisition, and no default Seqlane state directory.

The full repository gate passes frozen installation, documentation validation, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 563 runtime tests pass. All 94 compiled Oclif and worker tests pass.

Structural review separated HTTP attempt ownership from retry/deadline policy and the Promise facade. The remaining `classify` complexity increase and cohesive private attempt/retry functions are conscious tradeoffs. Type-only reachability reports are not unused runtime code. No baseline or acknowledgments changed, and no zero-debt claim is made.

The separate agent execution deadline in `runtime/execution/abortable.ts` remains a timer started by `onExecutionStarted`. Its Effect conversion belongs to S9's production caller and signal cutover. This task replaces classifier transport timing only. Telemetry projection remains S8 work; production Plan cutover remains S9 work.

## Documentation impact

Classification: implementation-only

- PRD: no change
- RFC: no change
- SPEC: no contract change
- TASK: record mixed-workflow callers, retry/deadline policy, cancellation, and secret handling evidence.
- ADR required: no

### Rationale

The active target spec requires an Effect HTTP client and Effect-owned time and retries. The preserved classifier contract already defines four attempts, retryable statuses, a shared 20-second transport budget, full observations, and private startup configuration. This slice changes their implementation.

### Required work

Keep nearby runtime and CLI documentation aligned with verified behavior. Record fake-clock policy tests and real local HTTP evidence through direct and compiled CLI callers. Preserve public Zod contracts and remove the replaced manual transport orchestration.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S6 commit `3434904`. Evidence is branch-local. Production Plan, agent deadline, and signal cutover remain S9 work.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-acp-transport: prerequisite task](./2026-10-21-effect-v4-acp-transport.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
