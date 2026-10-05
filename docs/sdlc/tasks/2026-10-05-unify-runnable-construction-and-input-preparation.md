---
id: task.unify-runnable-construction-and-input-preparation
title: Unify Runnable Construction and Input Preparation
status: in-progress
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

Implementation in progress; verification pending.

## Delivery state

Local work on `feat/exclusive-flow-choice`. No default-branch delivery claim.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
