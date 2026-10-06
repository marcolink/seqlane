---
id: task.unify-runnable-construction-and-input-preparation
title: Unify Runnable Construction and Input Preparation
status: completed
owners:
  - core
  - runtime
created: 2026-10-05
updated: 2026-10-05
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Unify Runnable Construction and Input Preparation

## Objective

Reuse invocation contracts and construction helpers across ordinary tasks,
repeat attempts and exclusive choices. Parse runnable input once per invocation.

## Upstream requirements

- [REQ-RUNTIME-001](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-runtime-001-compile-to-mastra)
- [REQ-CHOICE-001](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-choice-001-route-one-runnable)

## Scope

- Pass prepared input from the compiler into the invocation kernel. Keep raw
  direct-call validation and existing input-failure timing.
- Derive private options from canonical invocation contracts. Share runnable
  option resolution while retaining fluent states and task/workflow overloads.
- Share runnable Plan construction and definition registration. Preserve node
  IDs, bindings, dependency order and selected-arm session eligibility.
- Give the shared output-validation helper generic names and contract types.
  Preserve validation timing, admission, checkpoint capture and failure events.

## Out of scope

Public DSL changes, serialized Plan changes, session forking renames, caching,
payload limits, a second scheduler and unrelated review findings.

## Implementation plan

1. **Tracer bullet:** Execute one transformed-input task through real Mastra.
   Prove one parse, correct input delivery and rejection before execution.
   Then extend preparation to choice, repeat, child workflow and validation paths.
2. Unify private option types and DSL resolution. Verify output inference and
   invalid task/workflow options with existing public type tests.
3. Share Plan-node construction. Verify unchanged serialized Plans, identities,
   registry collision checks and session eligibility.
4. Generalize output-validation names and types. Verify selected-only validation,
   failure publication, cancellation and lock behavior.

## Affected areas

Core authoring contracts and builder; private runtime compiler, invocation kernel
and Mastra validation integration.

## Verification

Run test mapping before tests. Run focused core and real-Mastra integration
cases, production and spec typechecks, lint, formatting, documentation validation,
public runtime-boundary checks and the full suite.

## Completion criteria

All four slices pass their focused gates. Public DSL and Plan representations
remain unchanged. Input transforms run once and deterministic tasks call no model.

## Outcome

All four slices are implemented. Canonical invocation contracts supply private
builder options. One resolver serves ordinary, repeat and choice declarations.
One runnable constructor preserves each topology's dependency policy. Shared
output validation uses a schema-derived descriptor and generic helper names.

Real-Mastra tests prove one input parse for ordinary tasks, selected choice arms,
each repeat attempt, child workflows and mechanical validators. They also prove
that `null` and `undefined` transform results reach task execution and that
deterministic tasks make zero model calls. Existing lifecycle tests preserve
input-failure events, cancellation, admission and validation timing.

A comparison with the original builder produced byte-identical serialized Plans
and matching definition registries for a mixed workflow. The full repository
suite passed outside the sandbox, including 103 core and 475 runtime tests.
Production typecheck, core/runtime lint, formatting, test mapping and SDLC
validation passed. Spec typecheck retains three pre-existing errors in
`libs/action-code-review/src/pr-code-review-example.spec.ts`; no new errors.

The first full run hit sandbox `spawn EPERM` errors in process-lifecycle tests.
All seven lifecycle tests and the subsequent full suite passed outside it.
Ripwire contract checks found no incompatible callers. Quality findings were
reviewed: churn reflects earlier edits; moved helpers retain their existing
parameter counts; type-only references are reported as dead code.

## Delivery state

Implementation is on `feat/exclusive-flow-choice` for
[PR #170](https://github.com/marcolink/seqlane/pull/170). Default-branch delivery
remains pending until merge. `origin/main` was unchanged at `a25c830` after
implementation; no additional rebase was needed.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
