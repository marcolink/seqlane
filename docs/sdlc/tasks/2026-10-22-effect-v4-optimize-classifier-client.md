---
id: task.effect-v4-optimize-classifier-client
title: Classifier client reuse
status: completed
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

The classifier uses native `Effect.timeoutOrElse` for one total transport deadline
across attempts and retry waits. It removes the manual success/deadline tags and
race branch. One lazy deadline constructor preserves the last retry failure as
the cause. Monotonic checks still reject late success, including synchronous
observation delivery that consumes the budget.

The HTTP reader keeps native scoped streams, counts raw bytes once, and uses
`Buffer.concat` instead of a handwritten copy loop. The redundant decoded-text
UTF-8 re-encoding guard is removed. Fatal UTF-8 decoding, EOF validation, JSON
validation, secret redaction, complete raw observations and provider extensions
remain. No provider calls or dependencies were added.

Pinned native TypeSafe client source and official APIs were checked. Its response
schema keeps declared fields without returning the complete provider response;
its decision model rescales rounded probabilities and derives rating labels.
Those semantics differ from the owned strict scores, choices and legends. The
optional package also lacks verified Snyk evidence, so it was not installed.
Native `Stream.decodeText` is nonfatal and lacks the required final decoder flush.
The runtime README records these concrete retained boundaries.

Fake HTTP regressions exercise a BOM and split multibyte character at exactly
1 MiB, one excess raw byte, incomplete UTF-8 at EOF, complete provider extras,
no retry for invalid bodies, and absence of retained invalid response data.
The existing pending-request deadline test now covers both first and second
attempts, confirms in-flight abort, and preserves the preceding HTTP failure.
Existing score, choice, rounding, retry, cancellation and redaction tests remain.

Verification: 68 focused classifier/direct/compiled-CLI tests pass. All ten root
gates pass on Node 24.16.0, including frozen install, 357 canonical documents,
615 mappings, typechecks, all project tests, lint, all package builds, formatting,
Nx synchronization and diff checks. Runtime boundary checks pass. Full logs are
in `/private/tmp/seqlane-effect-v4-gates/opt-classifier`. Structural quality reports
zero regressions; changed reader and operation contracts have no incompatible
callers. No diagnostics were suppressed.

Classifier production TypeScript changes from 1,528 to 1,484 lines (-44).
Tests change from 1,464 to 1,582 (+118); shared fixtures stay at 24. Nearby docs
add 14 lines. Counts include the new response regression file.

Documentation sync: implementation matches the active spec. Public behavior and
contracts stay unchanged. The runtime README, task outcome and indexes are
updated; no required drift remains.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration`. The task commit
and final exact-head CI establish feature-branch delivery. No default-branch
merge or registry publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-native-telemetry](./2026-10-22-effect-v4-optimize-native-telemetry.md)
