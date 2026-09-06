---
name: implementation-delegation
description: Delegate implementation work to a Luna sub-agent after a task moves beyond investigation, discussion, or ideation. Use when beginning code, configuration, tests, documentation, or other execution work that does not need a higher-capability model.
---

# Implementation Delegation

## Boundary

Use this skill only after the task has moved from planning to execution. Investigation, discussion, options analysis, and ideation remain with the primary agent.

## Delegation rule

Before starting eligible implementation work, delegate the execution to a worker sub-agent whenever delegation is available. This includes code, configuration, tests, documentation, migrations, and other concrete task work. Keep work local when it is trivial, limited to one small file, tightly coupled, strictly ordered, or dependent on shared mutable state that cannot be isolated safely.

- Default to `gpt-5.6-luna` with `high` reasoning effort.
- Use `gpt-5.6-luna` with `xhigh` reasoning effort when the implementation is materially more complex, requires sustained multi-step reasoning, or has meaningful risk, but does not require a higher-capability model.
- Keep work with a higher-capability agent only when Luna is unlikely to perform it reliably. State the concrete reason before making that exception.

Give the worker a bounded, self-contained implementation objective, the relevant constraints, and the expected verification. The primary agent retains responsibility for task framing, reviewing the result, integration decisions, and the final response.

## Work splitting

Split work only into independent, bounded workstreams with disjoint write scopes. Give each worker explicit files or directories it may change and tell it what is out of scope. Do not run workers concurrently against shared contracts, schemas, lockfiles, central configuration, or other mutable state. Complete shared foundation work first, then parallelize independent slices, followed by integration, review, and retest.

## Worker execution contract

For implementation work, the worker edits files directly in its isolated or forked workspace. A prose suggestion without the implementation artifact is not completion. The worker must not reply to the user directly; it reports only to the parent. Read-only or research work may return findings without changing files.

The worker reports exactly one lifecycle state and separates it from the artifact and verification signals:

```text
STATUS: DONE | BLOCKED | FAILED
CHANGED:
- path/to/file, or none for read-only work
ARTIFACT:
- accessible workspace/ref/commit or applyable patch reference, or none for read-only work
VERIFY:
- command: result, or not run with reason
BLOCKER:
- none, or the precise blocker
REMAINING:
- none, or the next required action
```

`DONE` requires the requested artifact and its required verification. `BLOCKED` means progress needs an external decision, resource, or change. `FAILED` means the worker could not complete after attempting the task. Lifecycle status, work artifact, and verification are separate signals; the parent checks all three. A path inside an isolated worker workspace is not sufficient unless the parent can access it through the harness; the worker must provide an accessible workspace/ref/commit or an applyable patch reference.

## Parent coordination

While a worker runs, do non-overlapping work. Wait only when the worker is on the critical path for the next action. A worker may edit an isolated workspace, so do not use the parent working tree or absence of a parent diff as a progress signal. Use this lifecycle dispatcher:

- `RUNNING` or `PENDING`: continue non-overlapping work; wait or poll only when the result is needed for the critical path.
- `DONE`: obtain the accessible artifact through the harness, apply or merge it into the parent workspace, then run the relevant integration checks.
- `BLOCKED`: do not integrate; resolve or re-scope the blocker, or ask the user when a decision is required.
- `FAILED`: inspect the cause and send one targeted recovery or retry only when it is likely to succeed without changing scope; otherwise escalate or reassign the work.
- timeout: inspect status, continue bounded polling when the worker is still active, and send at most one focused follow-up when appropriate. If an external dependency is identified, classify the result as `BLOCKED`; if the worker is abandoned or remains without a terminal result after recovery, classify it as `FAILED`.

Never reimplement an active delegated task. When a worker returns without the required artifact or completion contract, send one focused follow-up requesting the missing direct edits or evidence, then classify the result as blocked or failed if the contract remains unmet. Do not integrate until the artifact is accessible and verified.

## Context handoff

Make the delegation prompt self-contained. Include as much task-relevant context already gathered as possible: the goal, decisions, constraints, affected files or relevant findings, applicable repository instructions, current state, and expected verification. Omit irrelevant or sensitive material. The worker should not need to rediscover context that the primary agent already has.

Do not treat planning-only work as implementation, and do not delegate actions that require authorization beyond the user's request.
