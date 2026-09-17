---
id: adr.standalone-cli-runs
title: Execute Standalone CLI Runs Without an Operational Host
status: accepted
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - prd.seqlane-on-mastra
  - rfc.mastra-runtime-and-operational-foundation
supersedes:
  - adr.local-mastra-operational-host
---

# Execute Standalone CLI Runs Without an Operational Host

## Context

A developer needs to execute one workflow from a file or installed package.
The command must not require an app, workflow catalog, Seqlane configuration,
manual adapter service startup, or persistent operational host.

The previous decision routes CLI runs through a Mastra server and its storage.
Current host initialization also loads the discovered catalog before the selected
workflow. Unrelated workflow imports can therefore prevent a direct run.

The user accepted this standalone scope on 2026-09-16. App-based hosting and
workflow discovery are separate future work. Existing implementation does not
constrain this decision.

## Decision

### decision-standalone-execution

`seqlane run` resolves one explicit entrypoint and executes its authored workflow
through Mastra. It loads that entrypoint and its dependencies only. Normal local
and package imports remain supported. Workflow modules are trusted executable
code, including their import-time side effects.

The run owns its runtime lifecycle. It does not start or connect to a Seqlane
operational server. Mastra remains the sole workflow engine. This decision does
not restore the former scheduler or create a second run store.

### decision-adapter-ownership

`seqlane run ./workflow.ts --adapter opencode` is sufficient when the workflow
accepts omitted input and the adapter prerequisites exist. Package entrypoints
use the same adapter contract.

Seqlane locates the installed executable, starts any required adapter service,
connects, and closes resources it owns. Existing adapter authentication and
permission configuration remain authoritative. No Seqlane adapter configuration
file, endpoint, or manually started service is required.

Adapter names are operator choices. They do not enter authored workflows,
serialized Plans, or public executor implementation types. This explicitly
narrows the CLI restriction in `adr.executor-neutral-workflow-authoring`.

### decision-model-authority

The workflow defines each agent session's model, directly or through its default.
The selected adapter must honor the model and explicit model settings or fail.
There is no CLI model override or silent substitution. Adapter compatibility can
constrain which workflows it can execute. This tradeoff is accepted.

Deterministic workflows require no adapter or model. Agent workflows require an
explicit adapter. Seqlane does not add a permission system for these runs.
The execution workspace is a working directory, not a security sandbox.

### decision-no-persistence

Seqlane retains run state in memory and writes results and progress to the
terminal streams. It creates no durable run database, history, recordings,
logs, saved results, session index, or artifact store. Logging and persistence
require a later decision.

Workflow-created files remain intentional outputs. Adapter-managed storage
follows the adapter's existing behavior. Seqlane neither promises to erase that
storage nor introduces its own persistent copy.

### decision-hosted-scope-preserved

This ADR supersedes `adr.local-mastra-operational-host` for the lifecycle split.
Its hosted decisions remain in force: `serve` owns a foreground Mastra host,
canonical hosted state, server routes, MCP, and tracing. Studio uses Community
Mastra surfaces. Unauthenticated operational endpoints remain loopback-only.

Hosted discovery, retention, and cross-surface identity requirements remain
unchanged. Standalone runs do not appear in that host's history or Studio.
This deliverable does not implement the proposed Seqlane app model.

## Alternatives considered

### Require a host or app for every run

This offers shared inspection but adds registration, service, and persistence
requirements to a one-shot command. It conflicts with the accepted CLI scope.

### Keep the host but use temporary storage

This reduces retained data but preserves unnecessary server startup and catalog
coupling. The command does not need HTTP or a shared operational surface.

### Restrict workflows to self-contained scripts

This prevents ordinary imports and package reuse. Import restrictions alone do
not isolate untrusted code. Normal module composition is the chosen contract.

### Infer an adapter and substitute available models

This reduces explicit choices but can change execution behavior unexpectedly.
The workflow's model and the operator's adapter remain authoritative instead.

## Consequences

- File and package workflows share one loading and execution contract.
- The CLI must resolve dependencies from the caller's project.
- Adapter process ownership and cleanup become direct-run responsibilities.
- Workflow imports can perform side effects before validation.
- A finished run cannot resume or support later server inspection.
- Host, catalog, recording, and runtime-profile flags leave the run command.
- Existing human, CI, and final JSON output contracts remain authoritative.

## Follow-up constraints

The standalone specification defines exact loading, input, workspace, lifecycle,
and migration behavior. The delivery task is the next implementation deliverable.
Implementation must verify the pinned Mastra APIs and reuse native runtime
facilities. No new dependency is selected by this ADR.

## Delivery state

Decision accepted. Implementation is pending. This documentation change does not
prove target-branch delivery. The delivery task must record validation and a
reachable delivery commit or merged pull request.

## Traceability

- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md#requirement-standalone-cli-runs)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [Previous host decision](./2026-09-05-local-mastra-operational-host.md)
- [Executor-neutral authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [task.deliver-standalone-cli-runs](../tasks/2026-09-16-deliver-standalone-cli-runs.md)
