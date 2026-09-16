---
id: task.standalone-adapter-lifecycle
title: Manage Standalone Adapter Lifecycle
status: completed
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.standalone-cli-runs
  - task.standalone-workflow-loading
supersedes: []
---

# Manage Standalone Adapter Lifecycle

## Objective

Prepare the operator-selected adapter without Seqlane configuration. Manage its
owned service, preserve native authentication and permissions, and enforce
workflow-owned model selection.

## Upstream requirements

- [requirement-adapter-lifecycle](../specs/2026-09-16-standalone-cli-runs.md#requirement-adapter-lifecycle)
- [requirement-model-compatibility](../specs/2026-09-16-standalone-cli-runs.md#requirement-model-compatibility)

## Dependencies

- [task.standalone-workflow-loading](./2026-09-16-standalone-workflow-loading.md)

## Scope

- Private adapter startup, readiness, ownership, connection, and cleanup.
- Adapter-specific service mechanics in their adapter package; generic lazy
  ownership and selection in the runtime.
- OpenCode no-config bootstrap and coherent supported-adapter diagnostics.
- Workflow/session model inheritance and compatibility validation.
- Lazy adapter acquisition on agent demand, without task discriminators.
- No adapter acquisition for deterministic work, including custom tasks.
- Failure, cancellation, concurrency, and foreign-process survival tests.

## Out of scope

- Hosted app/catalog redesign, persistence, and permission policy.
- Unrelated runtime or terminal refactoring.
- Earlier or later delivery steps beyond the integration seams needed here.

## Implementation plan

1. Inspect pinned adapter APIs and existing service/process lifecycle helpers.
2. Implement validated selection and a shared lazy run-owned adapter lease.
3. Manage required services with finite startup/shutdown bounds and cancellation.
4. Preserve SDK execution, native authentication, and native permission policy.
5. Enforce declared models without executor-default fallback for standalone runs.
6. Test missing prerequisites, unsupported choices, ownership, and cleanup.

## Affected areas

The private runtime and adapter modules named by the parent deliverable, plus
the adapter-neutral workflow model default in core. OpenCode owns its service
startup, endpoint parsing, readiness, and shutdown. The runtime owns the generic
lazy lease. Application composition supplies its concrete service factory.

## Verification

Run the test-mapping check before focused tests. Verify the linked requirements
through observable tests and the specification's verification matrix.
Run the repository install, typecheck, test, lint, build, format, Nx sync, and
Git whitespace gates. Preserve hosted behavior during this intermediate step.

## Completion criteria

- Linked requirements pass focused verification for this delivery step.
- Existing command behavior remains coherent until the final cutover.
- Required repository checks pass and review findings are resolved.
- Parent and child task outcomes record evidence separately from target-branch delivery.

## Outcome

Implemented the generic lazy adapter lease and adapter-owned OpenCode service
lifecycle. Concurrent acquisition shares one service; cancellation and close
release only owned resources. Cleanup failures remain observable without an
unhandled rejection from the abort listener.

Workflow model defaults now survive Plan serialization. Demand-time helpers
require an authored selection and validate available models and native reasoning
variants without fallback. No task discriminator was added. Strict checks are
not wired into the CLI until the next delivery steps.

Verification: 48 focused lifecycle, model, and registry tests passed, followed
by all eight repository gates. Two real OpenCode services used distinct ports,
passed health checks, and closed while an unrelated listener survived. This
smoke test made zero model calls. Core declarations contain no Mastra imports;
no production enterprise imports were introduced. SDLC validation passed.

An initial full-suite run hit existing CLI startup timeouts. A fresh review
reproduced neither failure: all 147 CLI tests and a fresh Nx CLI run passed.
The final full repository gate also passed without unrelated test changes.

The change check found five model-preflight callers and no incompatible calls.
Quality review removed unused eager standalone preflight options. Remaining
reported churn and small test-helper similarities need no shared abstraction;
the model capability closure and process lifecycle remain cohesive concerns.

Full removal of existing concrete runtime imports is tracked separately in
[task.decouple-runtime-adapter-composition](./2026-09-16-decouple-runtime-adapter-composition.md).

## Delivery state

Verified on `feat/standalone-cli-runs` in the commit containing this outcome.
The public command cutover remains pending. No target-branch delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)

- [task.standalone-workflow-loading](./2026-09-16-standalone-workflow-loading.md)
