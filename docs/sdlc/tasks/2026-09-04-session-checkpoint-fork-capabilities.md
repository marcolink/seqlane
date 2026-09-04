---
id: task.session-checkpoint-fork-capabilities
title: Map Session, Checkpoint, and Fork Capabilities
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-05
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Map Session, Checkpoint, and Fork Capabilities

## Objective

Make session reuse, checkpoint capture, and exact fork support explicit for
each adapter and active configuration.

## Dependencies

- [task.explicit-runtime-adapter-selection](./2026-09-04-explicit-runtime-adapter-selection.md)

## Delivery

- Follow-up order: 4
- Branch: `agent-adapters-04-session-capabilities`
- Pull request base: `agent-adapters-03-runtime-selection`
- Implementation agent: fresh high-reasoning subagent
- Delivery unit: one task branch and one pull request

## Upstream requirements

- `requirement-capability-preflight`
- `requirement-session-checkpoint-fork`
- `requirement-no-cross-adapter-fallback`

## Scope

- Define one private adapter capability schema.
- Resolve capabilities before session or workspace admission.
- Bind every checkpoint to its adapter, run, and compatible configuration.
- Map OpenCode SDK checkpoints and forks to native SDK operations.
- Declare ACP checkpoint and fork support only when the ACP implementation proves it.
- Reject unsupported shared or branch session policies before execution.

## Out of scope

- Prompt-based session reconstruction.
- Cross-adapter checkpoint conversion.
- Branch merging.
- Public exposure of native session identifiers.

## Implementation plan

1. Add capability declarations to adapter registration.
2. Connect capability preflight to session policy validation.
3. Brand and validate opaque checkpoint ownership.
4. Map OpenCode checkpoint and fork operations to its SDK session.
5. Remove the mixed ACP-execution and OpenCode-checkpoint path.
6. Add regression coverage for shared and branch sessions.

## Affected areas

- private agent adapter contract
- runtime session resolution and preflight
- ACP adapter capability mapping
- OpenCode SDK session implementation

## Verification

- Prove isolated and shared admission for each supported adapter.
- Prove that ACP rejects branch work when exact fork is unavailable.
- Prove an OpenCode task can publish a checkpoint and create a working branch.
- Prove that foreign and stale checkpoints fail before adapter activity.
- Run session, adapter, runtime, type, lint, and build tests.

## Completion criteria

- Each selected adapter exposes an accurate capability declaration.
- Session policy validation uses the declaration before execution.
- Execution, checkpoint capture, and fork use one adapter session lineage.
- Unsupported fork behavior fails without emulation or fallback.

## Outcome

Completed. Added private adapter capability preflight and run/configuration
bound checkpoint validation. Shared-session, checkpoint, and exact-fork
requirements now fail before session resolution when unsupported, while
OpenCode uses its native checkpoint/fork operations and ACP declares no
checkpoint or fork support. Runtime tests, dependent typechecks, and lint
pass.

The task branch is prepared for pull request delivery.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [task.explicit-runtime-adapter-selection](./2026-09-04-explicit-runtime-adapter-selection.md)
