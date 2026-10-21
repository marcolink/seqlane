---
id: task.effect-v4-native-adapters-and-observations
title: OpenCode and Codex with full observations
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-nested-workflows-and-validation
supersedes: []
---

# OpenCode and Codex with full observations

## Objective

Run one model task, tool activity, structured-output repair, checkpoint/fork, and cancellation path for each supported native harness.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run one model task, tool activity, structured-output repair, checkpoint/fork, and cancellation path for each supported native harness.
- Scope native SDK streams, requests, services, and late completion handling.
- Emit canonical observations and project them through the runtime rather than native adapter engine spans.
- Use safe protocol fixtures plus an authenticated installed-agent smoke test when available.
- Record unavailable credentials as missing live evidence; fixture success alone does not prove the live SDK path.

## Affected areas

`libs/opencode`, `libs/codex`, adapter contracts, runtime invocation context, protocol observations, and TUI detail projection.

## Verification

model/tool/skill values, usage, timing, attempts, correlation, capability errors, and cleanup at CLI and direct-call boundaries.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old native span projectors and opaque engine-context forwarding after both adapter callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-nested-workflows-and-validation: prerequisite task](./2026-10-21-effect-v4-nested-workflows-and-validation.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
