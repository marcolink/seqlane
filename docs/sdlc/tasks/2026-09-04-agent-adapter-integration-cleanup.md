---
id: task.agent-adapter-integration-cleanup
title: Add Adapter Integration Coverage and Complete Migration
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-05
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Add Adapter Integration Coverage and Complete Migration

## Objective

Prove both real adapter boundaries, remove the interim PR 19 design, and align
all nearby documentation with the active specification.

## Dependencies

- [task.session-checkpoint-fork-capabilities](./2026-09-04-session-checkpoint-fork-capabilities.md)

## Delivery

- Follow-up order: 5
- Branch: `agent-adapters-05-integration-cleanup`
- Pull request base: `agent-adapters-04-session-capabilities`
- Implementation agent: fresh high-reasoning subagent
- Delivery unit: one task branch and one pull request

## Upstream requirements

- all requirements in `spec.agent-adapter-boundary-and-capabilities`

## Scope

- Test the pinned Mastra ACP library with a controlled ACP process.
- Test the pinned OpenCode SDK with a controlled OpenCode server.
- Cover configuration, workspace, model, output, cancellation, permissions, and activity.
- Cover shared sessions, checkpoints, exact forks, and unsupported capability failures.
- Remove interim exports, duplicate orchestration, dependencies, and diagnostics.
- Update package, runtime, migration, and operator documentation.
- Add boundary checks for public declarations and serialized contracts.

## Out of scope

- New adapter implementations.
- Live external model tests in the required continuous integration gate.
- Public workflow authoring changes.
- Unrelated Mastra operational changes.

## Implementation plan

1. Add deterministic integration fixtures for ACP and OpenCode.
2. Exercise the pinned libraries instead of private fake-agent seams.
3. Add session-lineage and malformed-input regression tests.
4. Remove all code that exists only for the interim mixed adapter path.
5. Update documentation and boundary checks.
6. Run the full repository and documentation gates.

## Affected areas

- ACP and OpenCode adapter integration tests
- runtime profile and session tests
- package exports, manifests, and lockfile
- package READMEs and SDLC documentation
- repository boundary checks

## Verification

- Prove ACP behavior through the pinned Mastra ACP implementation.
- Prove OpenCode behavior through the pinned SDK client.
- Prove configured workspace and model propagation for each adapter.
- Prove cancellation and interaction rejection at each real boundary.
- Search for removed interim exports and mixed-session code.
- Run the complete repository and documentation gates.

## Completion criteria

- Deterministic integration tests exercise both real private boundaries.
- All PR 19 deferred architecture findings have regression coverage.
- The interim ACP/OpenCode path and duplicate exports no longer exist.
- Documentation describes explicit selection and accurate capabilities.
- The worktree passes the full repository verification gate.

## Outcome

Completed. Added controlled ACP-process and OpenCode-SDK integration coverage
for configured launch, workspace, model, structured output, activity,
cancellation, unresolved interaction, session reuse, and native checkpoint
fork behavior. The adapter boundary remains private and executor-neutral, and
the final affected package, runtime, mapping, format, and SDLC checks pass.

The task branch is prepared for pull request delivery.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [task.session-checkpoint-fork-capabilities](./2026-09-04-session-checkpoint-fork-capabilities.md)
- [task.mastra-agent-acp](./2026-09-03-mastra-agent-acp.md)
