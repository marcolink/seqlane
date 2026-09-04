---
id: task.mastra-local-task-dispatch
title: Dispatch Local Task Nodes Through the Mastra Compiler
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.local-mechanical-tasks
  - spec.mastra-runtime-and-operational-integration
  - adr.mastra-local-mechanical-tasks
supersedes: []
---

# Dispatch Local Task Nodes Through the Mastra Compiler

## Objective

Enable local task nodes in Mastra-compiled Plans to use the Seqlane local task
registry and the Mastra `LocalSandbox` process path.

## Upstream requirements

- Mastra remains the only generic runtime.
- Public task definitions and Plans remain free of Mastra types.
- Local tasks must not resolve an agent, model, or session.
- Direct argv execution, bounded output, cancellation, timeout, workspace
  admission, identity, and stable invocation events must remain intact.

## Scope

- Add Mastra compiler dispatch for `execution: "local"` task nodes.
- Resolve and validate local task definitions and schemas at the private
  runtime boundary.
- Preserve local-task workspace and invocation lifecycle semantics.
- Prove zero agent and model calls for local nodes.

## Out of scope

- Repeat support.
- Agent execution changes.
- Shell-string parsing or a Node subprocess fallback.
- Public Mastra types or runtime objects in Seqlane contracts.

## Implementation plan

1. Define the private Mastra invocation boundary for local task definitions.
2. Compile local task nodes to Mastra steps with the existing binding and
   schema validation rules.
3. Route `TaskContext.exec()` to `LocalSandbox` and preserve cancellation,
   timeout, output limits, and workspace lifetime.
4. Add malformed-input, failure, cancellation, and zero-model-call coverage.

## Affected areas

- `libs/seqlane-runtime/src/runtime/compile/`
- `libs/seqlane-runtime/src/runtime/local/`
- `libs/seqlane-runtime/src/runtime/invocation/`

## Verification

- Local nodes execute through Mastra-compiled workflows.
- Agent, model, and session infrastructure are not called for local nodes.
- Direct argv, output bounds, timeout, cancellation, and workspace behavior are
  covered by mapped tests.
- Repeat nodes remain rejected by the Mastra compiler.
- `pnpm docs:index` and `pnpm docs:validate` pass.

## Completion criteria

Mastra-compiled Plans either execute supported local task nodes through
`LocalSandbox` or reject malformed and unsupported local nodes before a run.

## Traceability

- [adr.mastra-local-mechanical-tasks](../adrs/2026-09-04-mastra-local-mechanical-tasks.md)
- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-deterministic-shell](./2026-09-03-mastra-deterministic-shell.md)
