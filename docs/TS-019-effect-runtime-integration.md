# TS-019 — Effect Runtime Integration

**Status:** Implemented
**Implements:** ADR-019
**Depends:** TS-001, TS-002, TS-003, TS-005, TS-015, TS-016
**Scope:** Private Effect implementation for the runtime

## 1. Objective

Replace the private Mastra workflow adapter with an Effect-backed sequential
runner.

The first version proves runtime parity. It does not change workflow
authoring, Plan serialization, runner IPC, executor routing, event contracts,
or execution policy.

## 2. Current Runtime Behavior

The current runtime performs these operations:

1. Validate and topologically order the Plan.
2. Create one private engine step for each ordered Plan node.
3. Add a private result step for workflow output resolution.
4. Start one run with the workflow input envelope.
5. Map engine success, failure, or cancellation to Seqlane outcomes.
6. Forward cancellation to the active run and executor `AbortSignal`.

Seqlane node functions already perform binding resolution, schema parsing,
executor calls, result retention, validation gates, repeats, and event
emission. The replacement must reuse those functions.

## 3. Target Runtime

```text
Seqlane Plan
    ↓
Seqlane validation and deterministic ordering
    ↓
Effect-backed private sequential runner
    ↓
Seqlane node execution functions
    ↓
Seqlane executors and event sink
```

Effect is a private implementation detail. No Effect value crosses a package
boundary.

## 4. Dependency

Replace the direct `@mastra/core` dependency in
`libs/seqlane-runtime/package.json` with the `effect` package.

The current npm stable version is `3.22.1` as of 2026-08-27. Pin the version
selected during implementation and keep `pnpm-lock.yaml` synchronized. The
Snyk package page reports no known security issues for `3.22.1`. The package
page also lists a newer release candidate as the latest non-vulnerable version.
The implementation must use one pinned version and verify its API against that
version.

The current Effect website serves v4 documentation while the current stable
npm package is v3. The implementation must not copy v4-only APIs without
version validation.

Do not add `@effect/workflow` for this migration. The current package release
(`0.19.1`) is a durable workflow engine with activities, idempotency, polling,
resume, and interruption semantics. It also peers on `@effect/rpc`,
`@effect/platform`, and `@effect/experimental` in addition to `effect`.
Those capabilities do not match the current local, single-run contract and
would require decisions for persistence, replay, and side-effect idempotency.
Use it only in a later durable-execution change.

## 5. Private Compatibility Surface

Implement a small private Effect-backed surface that can replace the current
engine surface without changing the compiler's node callbacks.

The surface must provide equivalent private operations:

- create a step with a Seqlane-owned ID;
- append steps in order;
- commit the ordered step collection;
- create one run with the Seqlane Run ID;
- start the run with the existing input envelope; and
- cancel the run idempotently.

The first implementation can retain the current compiler and run object shape
when that keeps the change small. It must remove all Mastra imports and runtime
dependency use.

The runner must execute each step in order through an Effect program. Each
step receives an `AbortSignal` that the executor can use. The runner must map
these results:

| Condition | Result |
| --- | --- |
| All steps complete | Existing successful run result |
| A step fails | Existing failed run result with the original cause |
| Cancellation is requested | Existing cancelled run result |

The existing private result step can remain during the parity migration. A
later cleanup can resolve workflow output directly after the last node.

## 6. Cancellation

Create one run-local cancellation mechanism for the Effect runner.

Cancellation must:

- be safe before the run starts;
- be safe when called more than once;
- interrupt the running Effect computation;
- preserve the existing executor `AbortSignal` behavior;
- emit one canonical `run.cancelled` event; and
- avoid mapping interruption to `run.failed`.

The runner process continues to own the outer `AbortController` used during
runtime profile setup. The active run cancellation path must remain compatible
with the runner control code.

## 7. Error Mapping

Keep Seqlane error categories and causes authoritative.

The Effect runner must not expose `Cause`, `Exit`, or Effect error classes in
Seqlane events or runner IPC. Map an Effect failure to the existing
Seqlane invocation or run error at the private runtime boundary.

Do not use error-message text to detect cancellation or failure categories.
Use the Effect result or interruption state and the existing Seqlane error
types.

## 8. Execution Policy

The first version keeps these policies unchanged:

- one ordered Plan execution stream;
- serial execution, including independent Plan nodes;
- no automatic retries;
- fail-closed validation gates;
- bounded repeat iterations;
- autonomous non-interactive execution; and
- existing Work, Run, and Invocation identity allocation.

Effect schedules, parallel fibers, durable sleep, deferred signals, and
workflow persistence are out of scope.

## 9. Required Tests

Add or update tests that prove observable parity.

### Scenario coverage

- successful task execution;
- ordered execution of dependent and independent nodes;
- input validation failure;
- executor failure;
- output validation failure;
- validation gate failure;
- repeat success and repeat limit failure;
- workflow output resolution;
- cancellation before run start;
- cancellation during executor execution;
- cancellation during runtime setup; and
- repeated cancellation requests.

### Boundary coverage

- no `@mastra` import remains in the runtime package;
- `seqlane-core` remains free of Effect and Mastra dependencies;
- Plan and event payloads remain unchanged;
- runner IPC payloads remain unchanged; and
- OpenCode receives the same input and cancellation signal contract.

Run the test-mapping check before the affected test suites.

## 10. Acceptance Criteria

### Scenario: the runtime completes a successful Plan

Given a valid Seqlane Plan and a test executor
When the runner starts the compiled workflow
Then nodes execute in the existing deterministic order
And the runner emits the existing successful Seqlane outcome

### Scenario: an executor fails

Given a valid Plan with a failing executor
When the runner starts the workflow
Then dependent nodes do not execute
And the existing Seqlane error retains the original cause

### Scenario: cancellation occurs during execution

Given a running executor that observes `AbortSignal`
When the caller cancels the active run
Then the executor receives cancellation
And the run ends with the existing cancelled outcome
And the run does not end with a failed outcome

### Scenario: the public contract remains unchanged

Given the Effect runtime replacement is installed
When a workflow crosses the runner boundary
Then Plan, event, IPC, and executor payloads remain compatible

## 11. Deferred Optimizations

After parity, a separate change can use Plan dependency frontiers and bounded
Effect concurrency for independent nodes. That change must define event
ordering, failure propagation, resource limits, and active invocation tracking.

The migration must not combine this optimization with the initial replacement.

## 12. Documentation Updates

Update runtime documentation to describe Effect as a private implementation
dependency. Keep public workflow and Plan documentation engine-neutral.

Update ADR-001 status to `Superseded by ADR-019`. Do not rewrite its historical
decision or rationale.

## 13. Verification

Run these checks after implementation:

```text
pnpm run test:mapping
pnpm exec nx test seqlane-runtime
pnpm exec nx typecheck seqlane-runtime
pnpm exec nx build seqlane-runtime
```

Then run the full repository verification gate before delivery.
