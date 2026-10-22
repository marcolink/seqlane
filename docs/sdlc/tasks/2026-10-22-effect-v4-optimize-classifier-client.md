---
id: task.effect-v4-optimize-classifier-client
title: Classifier client reuse
status: planned
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-native-telemetry
supersedes: []
---

# Classifier client reuse

## Objective

Remove duplicated infrastructure through the pinned Effect v4 APIs. Preserve supported behavior and observability.

## Upstream requirements

The active execution and operations spec owns all contracts. Oclif and public/wire Zod stay unchanged.

## Documentation impact

Classification: implementation-only.

- PRD, RFC, ADR and SPEC: no change; existing ownership and behavior apply.
- TASK: create this bounded follow-up after the completed migration.
- Nearby docs: update only changed private service or process descriptions.

## Scope

Evaluate native TypeSafeClient against pinned behavior and security evidence. Adopt only when it removes code without losing response fields, byte limits or decision behavior. Otherwise simplify the existing Effect HTTP seam and record the exact compatibility gap.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Classifier question -> bounded HTTP request -> validated complete response -> unchanged decision.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/runtime/src/classifier

## Verification

Fake HTTP proves payload, raw observation fidelity, scores, choices, rounding, provider extras, retry, cancellation and total deadline. No real model calls. No unverified new dependency.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Pending.

## Delivery state

Planned on `feat/effect-v4-migration`; no default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-native-telemetry](./2026-10-22-effect-v4-optimize-native-telemetry.md)
