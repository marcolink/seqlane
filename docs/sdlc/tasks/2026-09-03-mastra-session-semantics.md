---
id: task.mastra-session-semantics
title: Map Seqlane Session Semantics to Mastra
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Map Seqlane Session Semantics to Mastra

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-agent-acp](./2026-09-03-mastra-agent-acp.md)

## Delivery

- Stack order: 6
- Branch: `mastra-06-session-semantics`
- Pull request base: `mastra-05-agent-acp`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Map isolated, shared, and branch sessions to Mastra/runtime identities.
- Serialize shared sessions by Work, session name, and executor.
- Keep branches independent and prohibit merging.

## Out of scope

- Workspace compatibility constraints.
- Cross-run session merging.

## Implementation plan

1. Define deterministic session keys.
2. Lower session ordering into graph structure.
3. Switch session callers and remove replaced session scheduling.

## Affected areas

- `libs/seqlane-runtime/src/runtime/session/`
- OpenCode/ACP session adapter

## Verification

- Isolation, serialization, branch concurrency, and cross-Work leakage tests pass.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

All supported session modes use Mastra-compatible mechanisms with no parallel session scheduler.

## Outcome

Reuse-session consumers now receive deterministic graph dependencies in compiled
Seqlane and Mastra workflows. This serializes consumers that share a source
session before execution starts. Branch consumers remain independent because
checkpoint forks receive distinct executor sessions and can run concurrently.
Session identity remains scoped to one Work and executor resolver. The existing
session lock remains only as a defensive guard for dynamically created repeat
invocations and unconfirmed external activity.

Focused ordering, isolation, branch, and session-lock tests pass. No session
state crosses Work contexts, and no public contract contains Mastra types.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-agent-acp](./2026-09-03-mastra-agent-acp.md)
