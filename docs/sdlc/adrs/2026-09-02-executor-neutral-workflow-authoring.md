---
id: adr.executor-neutral-workflow-authoring
title: Keep Workflow Authoring and Plans Executor-Neutral
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes:
  - adr.opencode-executor-integration
---

# Keep Workflow Authoring and Plans Executor-Neutral

## Context

OpenCode is a possible Seqlane executor, but it is an implementation detail.
Workflow authors should describe Seqlane work, not select or configure the
agent runtime that performs it.

The current design exposes executor-specific concepts in several places:

- an `opencode.task` workflow factory;
- executor identity in task definitions and serialized Plans;
- OpenCode connection data in runtime-facing contracts;
- workflow fixtures and examples that import the OpenCode package.

This couples authored workflows and persisted Plans to one executor. It also
makes replacing, adding, or configuring executors a public API change.

This ADR supersedes only the workflow-authoring portion of
[adr.opencode-executor-integration](2026-09-02-opencode-executor-integration.md);
its runtime integration and repository harness decisions remain in force.

Mastra remains a private runtime implementation under adr.mastra-internal-workflow-engine. This ADR applies
the same boundary rule to OpenCode and to any future executor.

## Decision

Seqlane workflow authoring and Plan IR will be executor-neutral.

### Public authoring boundary

Workflow authors use only generic Seqlane authoring contracts. Those contracts
may describe task intent, input and output schemas, references, and other
executor-neutral task metadata.

They must not expose:

- executor names or selectors;
- OpenCode, Mastra, or provider-specific types;
- executor connection details;
- executor-specific prompts, sessions, messages, models, tools, or permissions.

There is no public `opencode.task` authoring API.

### Plan boundary

A serialized Plan contains Seqlane-owned definitions, nodes, bindings, and
schemas only. It does not contain an executor field, executor identity, or
OpenCode connection/configuration data.

### Runtime resolution

The runner resolves each task to an executor through a private, runner-owned or
injected binding registry. Workflow source and serialized Plans cannot choose
the executor.

Executor-specific request metadata remains in the private runtime adapter
boundary. OpenCode may remain the initial adapter without becoming part of the
workflow or Plan contract.

### Protocol and configuration boundary

Public runner requests, CLI options, and documented configuration use generic
Seqlane/runtime concepts. OpenCode-specific connection handling stays inside
the private runtime configuration and adapter.

## Options Considered

### Keep executor identity in task definitions

This is simple and matches the current implementation, but it makes executor
selection part of the workflow API and Plan format. It is rejected.

### Expose a generic executor abstraction to workflow authors

This removes the OpenCode name but still makes backend selection and runtime
configuration authoring concerns. It also encourages persisted Plans to carry
deployment details. It is rejected.

### Keep authoring and Plans neutral; resolve executors privately

This preserves a stable Seqlane contract, allows executor replacement and
configuration without rewriting workflows, and keeps adapter details testable
behind the runner. It requires private task-to-executor registration and more
runtime indirection. This option is chosen.

## Consequences

### Positive

- Workflow definitions remain portable across executor implementations.
- Plans remain stable when an executor changes.
- OpenCode and Mastra can evolve behind private boundaries.
- Runtime configuration can select or replace an executor without changing
  workflow source.
- Public API and documentation no longer promise OpenCode as a platform
  concept.

### Negative

- The runner must maintain private task-to-executor resolution.
- Debugging requires clear runtime diagnostics for failed or missing bindings.
- Executor-specific capabilities cannot be requested directly by workflow
  authors unless Seqlane first defines a generic contract for them.
- Existing OpenCode workflow fixtures and examples require migration.

## Required Follow-up

Before implementing this decision, create an implementation specification and
stories for the migration. The implementation must update the following
surfaces together:

- `docs/sdlc/specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md` — remove executor identity
  from the public Plan contract and examples;
- `docs/sdlc/specs/2026-09-02-opencode-executor-integration.md` — retain the private adapter
  decision but remove OpenCode workflow-authoring exposure;
- `docs/sdlc/prd/2026-09-02-seqlane.md` — describe executor-neutral authoring and generic runtime
  configuration;
- `docs/sdlc/adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md` — replace
  OpenCode-specific authoring examples;
- package READMEs, workflow fixtures, and examples — use generic Seqlane APIs;
- runner IPC and CLI documentation — remove OpenCode-specific public fields,
  flags, and examples;
- `AGENTS.md` — keep the executor-neutral boundary explicit for future changes.

The implementation must add boundary tests that fail if OpenCode or Mastra
details appear in core exports, workflow source, serialized Plans, runner IPC,
or public CLI/configuration.

## Constraints

- `seqlane-core` remains independent of Mastra and OpenCode.
- OpenCode adapter code may depend on OpenCode SDK/runtime details privately.
- Cross-package consumers use declared package exports.
- Breaking changes are allowed for this migration.
- Historical ADRs remain unchanged except for explicit lifecycle/status notes.

## Revisit Conditions

Revisit this ADR only if Seqlane deliberately makes executor selection a
workflow-level product capability, or if a future executor-neutral contract
cannot represent the required task semantics without backend leakage.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
