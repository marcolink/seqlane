---
id: task.explicit-runtime-adapter-selection
title: Define Explicit Runtime Adapter Selection and Configuration
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-05
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Define Explicit Runtime Adapter Selection and Configuration

## Objective

Select one validated agent adapter before model preflight, session creation,
or task execution.

## Dependencies

- [task.opencode-sdk-only-adapter](./2026-09-04-opencode-sdk-only-adapter.md)

## Delivery

- Follow-up order: 3
- Branch: `agent-adapters-03-runtime-selection`
- Pull request base: `agent-adapters-02-opencode-sdk`
- Implementation agent: fresh high-reasoning subagent
- Delivery unit: one task branch and one pull request

## Upstream requirements

- `requirement-explicit-adapter-selection`
- `requirement-capability-preflight`
- `requirement-no-cross-adapter-fallback`

## Scope

- Define one canonical Zod schema for private adapter configuration.
- Add a discriminated adapter identity for ACP and OpenCode.
- Register adapter factories in the private runtime composition root.
- Validate adapter-specific configuration before process or network activity.
- Remove URL-based adapter inference and implicit fallback.
- Redact secret configuration values from diagnostics and errors.

## Out of scope

- Workflow-level adapter selection.
- Adapter identity in Plans or public task definitions.
- Dynamic adapter changes during one run.
- Credential storage or secret distribution.

## Implementation plan

1. Define the private selection and configuration schema.
2. Add the adapter registry and factory resolution.
3. Move current OpenCode URL handling into OpenCode configuration.
4. Add explicit ACP configuration without OpenCode defaults.
5. Reject unknown, mixed, missing, and malformed selections.

## Affected areas

- private runtime configuration and profile resolution
- runtime composition roots
- ACP and OpenCode adapter factories
- CLI or server configuration loaders

## Verification

- Prove that each valid identity creates only its selected adapter.
- Prove that invalid configuration fails before external activity.
- Prove that no failure switches to another adapter.
- Prove that secrets do not appear in errors or events.
- Run runtime tests, type checks, lint, build, and configuration tests.

## Completion criteria

- Runtime configuration selects exactly one registered adapter.
- Each adapter receives only its validated configuration.
- URL shape and command names do not select an adapter implicitly.
- Workflow definitions, Plans, and events remain adapter-neutral.

## Outcome

Completed. Added private Zod-validated runtime adapter configuration and
deterministic ACP/OpenCode factory selection. Runtime profile resolution now
requires explicit adapter identity, validates configuration before adapter
activity, rejects mixed or unsupported configuration, and does not fall back
across adapters. Focused runtime adapter tests and the full runtime test
target pass.

The task branch is prepared for pull request delivery.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [task.opencode-sdk-only-adapter](./2026-09-04-opencode-sdk-only-adapter.md)
