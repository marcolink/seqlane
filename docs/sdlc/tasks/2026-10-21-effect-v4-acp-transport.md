---
id: task.effect-v4-acp-transport
title: ACP without the old transport
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-native-adapters-and-observations
supersedes: []
---

# ACP without the old transport

## Objective

Replace `@mastra/acp` with an exact checked official ACP SDK version.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Replace `@mastra/acp` with an exact checked official ACP SDK version.
- Use the selected version's supported client API, not remembered connection classes.
- Run ACP v1 initialization, model selection, prompt updates, tools, denied interaction, structured-output repair, and cancellation.
- Preserve explicit persistence configuration and report unsupported checkpoint/fork capabilities truthfully.

## Affected areas

`libs/acp/src/adapter.ts`, contracts, stream reducer, output validation, and observation projection.

## Verification

official-protocol subprocess fixture, malformed updates, cancellation/late rejection, and installed-agent smoke evidence where available.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove old ACP agent wrappers, engine span projection, and all old ACP dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-native-adapters-and-observations: prerequisite task](./2026-10-21-effect-v4-native-adapters-and-observations.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
