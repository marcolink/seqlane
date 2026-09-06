---
name: implementation-delegation
description: Delegate implementation work to a Luna sub-agent after a task moves beyond investigation, discussion, or ideation. Use when beginning code, configuration, tests, documentation, or other execution work that does not need a higher-capability model.
---

# Implementation Delegation

## Boundary

Use this skill only after the task has moved from planning to execution. Investigation, discussion, options analysis, and ideation remain with the primary agent unless delegation would clearly help.

## Delegation rule

Before starting implementation, delegate the execution work to a worker sub-agent whenever delegation is available. This includes code, configuration, tests, documentation, migrations, and other concrete task work.

- Default to `gpt-5.6-luna` with `high` reasoning effort.
- Use `gpt-5.6-luna` with `xhigh` reasoning effort when the implementation is materially more complex, requires sustained multi-step reasoning, or has meaningful risk, but does not require a higher-capability model.
- Keep work with a higher-capability agent only when Luna is unlikely to perform it reliably. State the concrete reason before making that exception.

Give the worker a bounded, self-contained implementation objective, the relevant constraints, and the expected verification. The primary agent retains responsibility for task framing, reviewing the result, integration decisions, and the final response.

## Context handoff

Make the delegation prompt self-contained. Include as much task-relevant context already gathered as possible: the goal, decisions, constraints, affected files or relevant findings, applicable repository instructions, current state, and expected verification. Omit irrelevant or sensitive material. The worker should not need to rediscover context that the primary agent already has.

Do not treat planning-only work as implementation, and do not delegate actions that require authorization beyond the user's request.
