---
id: task.mastra-plan-compiler
title: Compile Seqlane Plans to Mastra Workflows
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Compile Seqlane Plans to Mastra Workflows

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-runtime-spine](./2026-09-03-mastra-runtime-spine.md)

## Delivery

- Stack order: 3
- Branch: `mastra-03-plan-compiler`
- Pull request base: `mastra-02-runtime-spine`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Compile validated static Plans into Mastra workflow registrations.
- Create one Mastra step per Seqlane invocation.
- Preserve typed bindings, schemas, deterministic IDs, and workflow outputs.

## Out of scope

- Agent and shell implementation details.
- Session/workspace synthetic edges.

## Implementation plan

1. Reuse canonical Plan validation.
2. Implement the pure normalized-definition compiler.
3. Switch compiler fixtures and remove the superseded compile path.

## Affected areas

- `libs/seqlane-runtime/src/runtime/compile/`
- Plan/compiler fixtures

## Verification

- Graph and schema tests cover malformed inputs and cycles.
- Step IDs and metadata are deterministic.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Static Seqlane Plans execute through compiled Mastra workflows with no compiler fallback.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-runtime-spine](./2026-09-03-mastra-runtime-spine.md)
