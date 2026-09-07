---
id: task.account-opencode-invocation-metrics
title: Account for all OpenCode model responses per invocation
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Account for all OpenCode model responses per invocation

## Objective

Preserve accurate Seqlane model-cost accounting when one OpenCode invocation
receives multiple completed model responses, including structured-output repair
responses or a terminal failure after a paid response.

## Upstream requirements

Implement [invocation metrics accounting](../specs/2026-09-02-opencode-executor-integration.md#invocation-metrics-accounting)
from [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md).

## Scope

- Retain every normalized metrics callback for the current invocation.
- Aggregate duration, cost, and available token counters across all completed
  model responses using the existing `SeqlaneInvocationMetrics` contract.
- Preserve `model` and `provider` only when their values are consistent across
  the responses; omit an inconsistent identity rather than misattribute cost.
- Emit observed metrics as persistent task output when executor failure or
  cancellation occurs after a model response.
- Add focused regression coverage for repair attempts, mixed identities, and
  terminal paid failures.

## Out of scope

- Adding a public attempt-level metrics field or changing the existing metrics
  event shape.
- Changing OpenCode retry bounds, structured-output behavior, model selection,
  or cost calculation supplied by OpenCode.
- Reconstructing metrics when OpenCode reported none.
- Changing workflow-level ledger aggregation or renderer presentation.

## Implementation plan

1. Capture each response's normalized metrics during one executor invocation.
2. Aggregate the retained values at the invocation boundary and preserve
   truthful identity semantics.
3. Publish one persistent metrics output for successful and terminal paid
   invocations, while retaining the existing failure and cancellation paths.
4. Add regression tests for multiple responses, inconsistent model/provider
   values, and failure after metrics reporting.

## Affected areas

- `libs/seqlane-opencode/src/executor.ts`
- `libs/seqlane-runtime/src/runtime/invocation/invocation-execution.ts`
- `libs/seqlane-runtime/src/runtime/invocation/invocation-execution.spec.ts`

## Verification

- `pnpm exec vitest run src/runtime/invocation/invocation-execution.spec.ts`:
  5 tests passed, including metrics retention before cancellation.
- `pnpm exec nx test seqlane-runtime`: blocked by Nx lock-file permissions in
  `/Users/marco.link/projects/contentful/taskflow/.nx`.
- `pnpm docs:index`: passed.
- `pnpm docs:validate`: passed, 230 documents.
- `git diff --check`: passed.

## Completion criteria

- Every completed model response in an invocation contributes to normalized
  duration, cost, and available token totals.
- A repair response is not overwritten by a later response.
- Mixed model/provider identities are not misrepresented.
- Metrics observed before a paid terminal failure or cancellation remain
  available through the persistent task output event.
- Existing metrics shape and workflow ledger behavior remain compatible.

## Outcome

Completed. The runtime now retains and aggregates every reported model response
for an invocation, preserves only consistent observed model/provider identity,
retains the effective `modelSelection`, and emits observed metrics after a paid
terminal failure or cancellation. Regression coverage verifies repair-attempt
aggregation, terminal failure accounting, and cancellation accounting.

## Traceability

- Contract: [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
