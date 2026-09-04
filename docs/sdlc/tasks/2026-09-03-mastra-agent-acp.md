---
id: task.mastra-agent-acp
title: Run Agent Tasks Through Mastra ACP
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Run Agent Tasks Through Mastra ACP

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-deterministic-shell](./2026-09-03-mastra-deterministic-shell.md)

## Delivery

- Stack order: 5
- Branch: `mastra-05-agent-acp`
- Pull request base: `mastra-04-deterministic-shell`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Invoke OpenCode through Mastra-supported ACP or coding-agent primitives.
- Map model, provider, reasoning, structured output, cancellation, and telemetry.
- Preserve repository instructions, skills, tools, plugins, and MCP configuration.

## Out of scope

- Alternative executors.
- Undocumented native OpenCode behavior.

## Implementation plan

1. Document real ACP capability gaps against the pinned version.
2. Implement the adapter and switch agent callers.
3. Delete or shrink the superseded native path.

## Affected areas

- `libs/seqlane-opencode/`
- runtime executor integration

## Verification

- Agent success, failure, structured output, and cancellation pass.
- No OpenCode or Mastra types leak into public contracts.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

The representative agent task executes through Mastra ACP with only documented native escape hatches.

## Outcome

Agent task execution now routes through the pinned Mastra ACP adapter before any
native OpenCode path. The adapter preserves the selected provider and model,
repository task instructions, structured-output validation and repair,
cancellation, activity reporting, and invocation metrics. Mastra ACP's current
capability gaps for native structured-output readback and portable reasoning
variants are reported as diagnostics; the native adapter remains available only
for those documented gaps.

Focused ACP success, malformed-output, cancellation, activity, configuration,
and missing-task tests pass. Mastra and OpenCode types remain private to the
adapter boundary.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-deterministic-shell](./2026-09-03-mastra-deterministic-shell.md)
