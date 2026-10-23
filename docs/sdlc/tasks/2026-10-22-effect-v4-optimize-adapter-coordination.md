---
id: task.effect-v4-optimize-adapter-coordination
title: Native adapter coordination
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-hosted-services
supersedes: []
---

# Native adapter coordination

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

Replace manual completion promises and resolver state with native Deferred and scoped callback interop. Evaluate other adapter coordination for equivalent duplication. Keep Promise facades only at SDK/public edges.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Codex request -> correlated response/turn -> cancellation and confirmed stop.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/codex; libs/adapter; libs/acp; libs/opencode

## Verification

Retain full native observations, late-response tombstones, unknown-ID failure, original causes, capabilities, one SDK read loop, and confirmed external termination.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Codex request and turn waits use native Deferred values. Pending request records retain only the method and result. Scoped abort listeners precede writes; cancellation retains bounded response tombstones. Turn-start recovery, completion, interruption confirmation, and scoped transport observers compose in the execution context.

OpenCode prompt, monitor, readiness, and cancellation compose in the prompt semaphore's Effect context. Native fibers replace the private evaluation sandwich. SDK Promise edges still pass interruption signals and observe late settlement. Parent interruption waits for external abort acknowledgement. Two Promise conversions remain only when publishing late monitor or scope termination handles after a cleanup timeout.

The pinned Effect 4.0.5 source confirms that `runPromise` and `Cause.squash` retain typed failures, including false, zero, null, and undefined. Adapter regressions verify these original causes through the real facade. No custom cause facade, dependency change, public contract change, or real model call was added.

Focused evidence: test mapping; Codex and OpenCode production builds; repository spec typecheck and runtime-boundary audit; complete final adapter suites (88 Codex tests and 139 OpenCode tests). Final focused checks include synchronous abort during a request write, tombstone survival, inherited monitor span, cancellation during preparation, confirmed external abort after parent interruption, and original falsey termination causes. The formatted production scope decreased from 3,077 to 3,044 lines, including the two SDK helpers. Explicit evaluation sites decreased from 21 to 14; manual Promise-constructor sites decreased from eight to zero. All ten repository gates pass: frozen install, docs validation, 602 test mappings, typecheck, tests across 20 projects, lint, all builds, formatting, Nx sync and diff checks. No required behavior or documentation drift remains.

Retained native API gaps: Codex needs JSONL request IDs, protocol validation, bounded tombstones, and one stdout read loop. OpenCode can leave a prompt or iterator pending after local interruption; bounded remote abort and late settlement handles therefore remain. ACP's remaining manual child-exit wait belongs to the dependent process-services task; the generic adapter package has no equivalent completion resolver to replace.

Structural review retains native callback shapes, explicit native composition and migration churn. These diagnostics remain visible; no quality baseline or acknowledgements were added.

## Delivery state

Completed locally in this task's commit on `feat/effect-v4-migration`. Final published-head CI belongs to the last optimization task. No default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-hosted-services](./2026-10-22-effect-v4-optimize-hosted-services.md)
