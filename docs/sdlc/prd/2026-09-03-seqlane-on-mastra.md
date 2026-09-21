---
id: prd.seqlane-on-mastra
title: Seqlane on Mastra
status: accepted
owners:
  - core
created: 2026-09-03
updated: 2026-09-21
upstream:
  - brd.seqlane
supersedes:
  - prd.seqlane
---

# Seqlane on Mastra

## Summary

Seqlane will become a thin, opinionated software-engineering workflow layer on top of Mastra.

Seqlane continues to define the product-facing programming model: workflows, coding tasks, deterministic shell tasks, schemas, session semantics, workspace coordination, executor selection, Work identity, provenance, and CLI commands. Mastra becomes the sole generic runtime and operational foundation.

This is a replacement, not a compatibility-preserving rewrite. When Mastra provides an adequate primitive, Seqlane must use it and delete the superseded implementation.

## Problem

Seqlane currently owns infrastructure that is necessary to run coding workflows but is not distinctive to the product: workflow execution, scheduling, run state, persistence, process management, tracing, server endpoints, MCP exposure, and a dedicated Studio. Maintaining these capabilities increases the codebase, slows product work, and creates two competing abstractions whenever Mastra already solves the same problem.

The valuable part of Seqlane is narrower:

- a type-safe DSL for software-engineering workflows;
- coding-agent and deterministic-task semantics;
- explicit session and workspace coordination;
- stable workflow-level reuse and discovery;
- useful Work identity and provenance;
- a focused, non-interactive CLI.

## Product vision

A developer defines a repeatable coding workflow in Seqlane and runs it locally or in CI. Seqlane presents a small, stable coding-workflow API. Mastra supplies the runtime, agent, workspace, storage, observability, server, MCP, and Studio capabilities underneath it.

The result should feel like Seqlane to workflow authors and like Mastra to runtime maintainers.

## Goals

1. Preserve and simplify the Seqlane public surface: `workflow`, `task`, `shell`, schemas, sessions, workspace policies, executors, Work identity, and CLI commands.
2. Keep a workflow—not an individual task—as the public unit of discovery, reuse, composition, and execution.
3. Use Mastra as the only generic workflow runtime.
4. Run deterministic shell work without an LLM call or AI-token cost.
5. Retain explicit session behavior: isolated sessions, serialized shared sessions, and branches without session merging.
6. Retain workspace coordination without rebuilding a permissions system inside Seqlane.
7. Reuse Mastra for persistence, run state, retries, cancellation plumbing, workspaces and sandboxes, processes, agents and ACP, tracing, server APIs, MCP, and Studio.
8. Materially reduce Seqlane's code, dependency, package, test, and maintenance footprint.
9. Distribute the CLI and workflow-authoring API through the public npm registry.
9. Remove obsolete implementations and concepts as part of each migrated slice.

## Non-goals

- Building or preserving a second workflow engine, scheduler, persistence layer, generic server, MCP server, tracing system, or Studio.
- Preserving internal APIs merely to reduce the migration diff.
- Maintaining Effect-based orchestration when Mastra owns the equivalent lifecycle.
- Exposing Mastra-specific types as part of the stable Seqlane authoring API.
- Making individual tasks a separately versioned public plugin surface in V1.
- Implementing session-branch merging.
- Encoding executor tool permissions in workspace policy.
- Depending on Mastra Enterprise Edition, Mastra Cloud, or a hosted Mastra service.
- Rebranding, forking, or embedding a custom copy of Mastra Studio.
- Delivering the Renovate repair workflow as part of the runtime migration.

## Primary users and use cases

### Workflow authors

Authors compose typed coding and shell tasks into reusable workflows while remaining insulated from Mastra's lower-level graph API.

### Workflow operators

Operators discover, inspect, run, observe, cancel, and debug workflows through the Seqlane CLI. They can open the standard Mastra Studio for deeper local inspection.

### Seqlane maintainers

Maintainers implement coding-specific behavior and integrate Mastra primitives rather than maintaining generic runtime infrastructure.

Migration verification uses representative agent and deterministic-task fixtures. The Renovate repair workflow remains a product use case but is delivered independently from the runtime migration.

## Product requirements

### Authoring and composition

- The public DSL must remain type-safe across task inputs, task outputs, dependencies, and workflow outputs.
- `workflow()` is the public atom. Tasks are workflow implementation details unless a later product decision introduces a stable task-sharing contract.
- `task()` represents agentic work and must use a configured executor.
- `shell()` represents deterministic process execution and must not invoke a model.
- Dependency references must be validated before execution.
- Repository- and user-scoped workflow discovery must remain possible without silent ambiguity.

### Execution

- A Seqlane workflow must compile to and execute as a Mastra workflow.
- Each Seqlane task invocation must have a corresponding inspectable Mastra step execution.
- Runs must proceed non-interactively to success, failure, or cancellation.
- Cancellation must propagate to active agent and process work where the underlying capability permits it.
- Runtime state and persistence must use Mastra facilities; Seqlane must not maintain a parallel canonical store.

### requirement-standalone-cli-runs

`seqlane run` executes one explicit file or installed package workflow without
an app, catalog, Seqlane configuration, or operational server. Normal imports
remain supported as trusted local code.

The operator selects an adapter with `--adapter`. Seqlane manages required
adapter startup and cleanup. Installed executables and native authentication
are prerequisites. Adapter configuration remains authoritative for permissions.
Deterministic workflows need no adapter or model.

The workflow owns model selection. Incompatible models or explicit settings
fail instead of falling back. Standalone runs retain no Seqlane history, logs,
recordings, saved results, sessions, or artifacts. Workflow-created outputs and
adapter-managed storage remain outside this retention guarantee.

Results and progress use terminal streams. Hosted persistence and inspection
remain separate capabilities. App-based hosting is outside this deliverable.

### Coding agents, sessions, and workspaces

- Existing repository instructions, `AGENTS.md`, skills, tools, plugins, and MCP configuration remain authoritative in the selected coding harness.
- OpenCode integration should use Mastra-supported ACP or coding-agent primitives first. Native OpenCode APIs are an escape hatch for capabilities that Mastra cannot supply.
- Isolated sessions are the default.
- Tasks sharing a session are serialized.
- A branch may execute independently from its parent; merging branches is not supported.
- Workspace policy controls execution compatibility and ordering. It does not attempt to define runtime tool permissions.

### Operator experience

- The Seqlane CLI remains the stable entry point for discovery, planning, execution, progress, cancellation, and final results.
- A terminal `seqlane run` shows passive live nested workflow progress,
  relevant inline details, and total run elapsed time without keyboard input.
- A CI `seqlane run` writes permanent progress lines and does not require a
  terminal input device.
- A final-result `seqlane run` writes one machine-readable result. It writes no
  progress output.
- Users can select a run output mode explicitly. The CLI selects a safe default
  from the terminal and CI environment.
- `seqlane studio` launches the standard Mastra Community Studio against the Seqlane/Mastra runtime.
- Seqlane does not maintain a dedicated Studio application.
- Hosted logs, traces, and persisted run state remain inspectable through Mastra surfaces. Standalone runs retain no operational history.

#### requirement-run-output-quality

The run view is a primary product surface. A user must understand these facts
without reading raw logs:

- which workflow is running
- how long the complete run has taken
- which work is active, complete, waiting, retrying, failed, or skipped
- where selected work exists in nested workflow containment
- why work waits, retries, fails, or stops
- what final result the workflow returned

Parallel activity and deep nesting must remain easy to scan. Color and motion
can add meaning, but the interface must remain clear without either feature.

### Migration and compatibility

- Preserve intentional public behavior where it belongs to Seqlane's product surface.
- Internal modules, packages, exports, tests, and dependencies have no compatibility guarantee when Mastra replaces their responsibility.
- Do not ship permanent old/new adapters or dual runtimes.
- Every migrated slice includes deletion of its superseded implementation and stale documentation.
- Any temporary bridge must have a named removal condition and must be removed before the migration is declared complete.

### Licensing

- Use only Mastra components available under its Community/open-source licensing.
- Do not import, copy, bundle, or depend on code under an `ee/` path.
- Do not require an enterprise license, Mastra Cloud, or a hosted Mastra service for supported Seqlane use cases.
- Studio integration is limited to launching the upstream Community Studio; Seqlane does not rebrand or redistribute a modified Studio.
- Recheck the dependency/license boundary whenever Mastra is upgraded.

## Success criteria

- A representative Seqlane workflow compiles to Mastra and completes end to end.
- Agent tasks, deterministic shell tasks, dependencies, typed data flow, sessions, workspace ordering, cancellation, and failures behave as specified.
- A representative workflow containing agent and deterministic tasks passes end to end.
- `seqlane studio` opens the upstream Community Studio and exposes useful run information.
- No generic Seqlane runtime, scheduler, persistence store, server, MCP server, tracing backend, or dedicated Studio remains.
- Superseded Effect orchestration and its unused dependencies are removed.
- Public API checks demonstrate that no accidental Mastra types leak into the Seqlane DSL.
- The repository is materially smaller, measured by deleted production code, removed projects/packages, and removed direct dependencies. The migration PR must report these deltas.
- Lint, typecheck, unit tests, integration tests, and the representative end-to-end workflow pass.

## Product decisions

| Area | Decision |
| --- | --- |
| Generic runtime | Mastra only |
| Stable authoring surface | Seqlane DSL |
| Public reusable atom | Workflow |
| Deterministic work | `shell()` with no LLM call |
| Coding-agent integration | Mastra/ACP first; native OpenCode only when required |
| Session variants | Isolated, shared, branch; no merge |
| Workspace authority | Ordering/compatibility policy, not tool permissions |
| Operational UI | Upstream Mastra Community Studio |
| Run output | Interactive terminal, append-only CI, or final machine result |
| Dedicated Seqlane Studio | Delete |
| Enterprise/hosted dependency | None |
| Migration bias | Delete over adapt |

## Risks

- **Mastra API churn:** isolate version-sensitive code at a narrow integration boundary and verify APIs against the pinned dependency before implementation.
- **Leaky abstractions:** enforce public API tests and dependency-boundary checks.
- **Semantic mismatch:** translate Seqlane session/workspace rules into graph constraints before starting a run rather than recreating a scheduler beside Mastra.
- **Half-migration:** make deletion part of every phase's exit criteria and reject permanent dual implementations.
- **License drift:** scan dependency changes and prohibit `ee/` imports.


## Traceability

- [adr.public-npm-release](../adrs/2026-09-21-public-npm-release.md)
- [spec.public-npm-distribution](../specs/2026-09-21-public-npm-distribution.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)

- [brd.seqlane: Seqlane](../brd/2026-09-02-seqlane.md)
- Supersedes [prd.seqlane: Seqlane](./2026-09-02-seqlane.md).
