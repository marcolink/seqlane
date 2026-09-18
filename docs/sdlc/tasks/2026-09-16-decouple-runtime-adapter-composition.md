---
id: task.decouple-runtime-adapter-composition
title: Decouple Runtime from Concrete Adapter Implementations
status: in-progress
owners:
  - core
created: 2026-09-16
updated: 2026-09-18
upstream:
  - spec.agent-adapter-boundary-and-capabilities
  - task.deliver-standalone-cli-runs
supersedes: []
---

# Decouple Runtime from Concrete Adapter Implementations

## Objective

Make the runtime depend only on the generic adapter contract. Application
composition selects and supplies the concrete adapter implementation.

## Upstream requirements

- [requirement-composition-owned-adapters](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md#requirement-composition-owned-adapters)
- [requirement-agent-adapter-boundary](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md#requirement-agent-adapter-boundary)

## Dependencies

- [task.deliver-standalone-cli-runs](./2026-09-16-deliver-standalone-cli-runs.md)

This is separate follow-up work. It is not a fifth standalone CLI delivery step.

## Scope

- Generic adapter binding and lifecycle contracts accepted by the runtime.
- Concrete selection and configuration in CLI, server, and worker composition.
- Removal of concrete adapter imports and dependencies from the runtime package.
- Generic model, capability, cancellation, error, and session handling.
- Boundary enforcement and regression tests for each supported integration.

## Out of scope

- Public adapter plugin APIs or workflow-owned adapter selection.
- New adapter implementations, permission policy, persistence, or discovery.
- Changes to the standalone command's accepted user experience.

## Implementation plan

1. Map concrete imports, default factories, and construction call sites.
2. Define the smallest generic binding needed by runtime execution.
3. Move concrete factories and configuration ownership to composition roots.
4. Inject the selected binding into direct, hosted, and worker execution.
5. Remove concrete package imports, re-exports, error checks, and dependencies.
6. Enforce the boundary and reconcile affected documentation.

## Verification

Use a fake generic adapter to prove runtime execution without any concrete
adapter package. Test actual composition for the supported adapters. Preserve
models, sessions, cancellation, cleanup, and diagnostic redaction.

Prove deterministic standalone execution starts no adapter. Prove custom tasks
can request an agent without task discriminators. Keep process-local adapter
instances out of serialized Plans and runner IPC.

Run the test-mapping check, focused integration tests, and the full repository
install, typecheck, test, lint, build, format, Nx sync, and whitespace gates.

## Completion criteria

- The runtime package imports and depends on no concrete adapter package.
- Concrete implementations enter through an injected generic contract.
- CLI, hosted, and worker entrypoints select adapters at composition roots.
- Required regressions and boundary checks pass.

## Outcome

Implementation in progress. Runtime construction now moves to adapter packages
and CLI or Action composition. The runtime accepts only an already selected
generic agent runtime.

The direct workflow API accepts a bootstrapped agent runtime. The code-review
Action bootstraps its selected OpenCode runtime after review admission, then
passes that runtime into direct execution. The runtime receives no adapter
configuration, endpoint, or concrete adapter package.

## Delivery state

In progress. No target-branch delivery is claimed.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [task.deliver-standalone-cli-runs](./2026-09-16-deliver-standalone-cli-runs.md)
