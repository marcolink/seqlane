---
id: prd.seqlane-runtime
title: Seqlane Runtime Product Requirements
status: accepted
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - brd.seqlane
supersedes:
  - prd.seqlane
---

# Seqlane Runtime Product Requirements

## Summary

Seqlane provides a typed, reusable software-engineering workflow API and a focused CLI. Runtime technology is an internal implementation choice; authors use Seqlane contracts and behavior.

## Context

The product owns workflow authoring, task semantics, session and workspace policy, executor contracts, Work identity and provenance, and terminal experience. Execution, process ownership, cancellation, and operational telemetry support those outcomes. Oclif remains the CLI framework. Zod remains the source of truth for public and wire contracts.

## Goals

- Preserve typed workflows, task inputs and outputs, validation, dependencies, and composition.
- Preserve deterministic shell tasks with zero model calls.
- Preserve isolated, shared, checkpoint, and fork session semantics and workspace coordination.
- Preserve executor independence, Work identity, provenance, cancellation, and normalized outcomes.
- Preserve terminal, machine-readable, hosted inspection, and observation behavior through migration.
- Keep runtime-engine types out of public authoring and serialized contracts.

## Non-goals

- Changing workflow authoring semantics as a side effect of a runtime migration.
- Replacing Oclif or public and wire Zod validation.
- Durable replay of external coding actions, distributed execution, or a replacement Studio product.

## Users and use cases

Workflow authors define typed workflows without depending on runtime implementation types. Operators run workflows locally or in CI, observe results, and inspect hosted runs where configured. Maintainers evolve runtime execution while preserving product contracts.

## Product requirements

- `workflow()` remains the unit of discovery, reuse, composition, and execution.
- Tasks preserve declared input/output validation, dependency behavior, and task identity.
- `shell()` runs deterministic work without model or agent acquisition.
- Session and workspace policies remain explicit, coordinated, and cancellation-aware.
- Executor-specific APIs and connection details remain behind private adapter boundaries.
- Run outcomes, progress, observations, terminal output, and hosted inspection retain their documented Seqlane semantics.
- Standalone CLI runs retain their documented isolation and retention behavior.

### requirement-exclusive-flow-choice

Workflow authors can select exactly one of two declared task or child-workflow
paths from a Boolean value in workflow input or an earlier task result. Both
paths are required. The unselected path does not run, and a successful choice
provides one typed result to later tasks. Authors can put multiple steps in a
path by using a child workflow.

The choice is visible during inspection and execution. The selected task or
workflow keeps its own identity and existing session, workspace, failure, and
cancellation behavior. The unselected path is reported as not selected and
does not make a successful run fail.

### requirement-classifier-tasks

Workflow authors can add a classifier task that evaluates one state against
multiple named Choice, Score, and Noul questions in one model request. The
complete questions remain fixed in the task definition. A `state` callback
selects a JSON string, object, or array from the validated task input for each
invocation. All declared questions evaluate that shared state.

The task returns the complete validated probabilistic result, including the
selected Choice, distributions, Score value and legend, Noul probability,
model identity, and usage. Seqlane does not convert probabilities into Boolean
decisions or impose application thresholds. A later task can interpret them.

An operator supplies one classifier endpoint, model ID, and any required
credential for a run. Workflow definitions and Plans contain no endpoint or
credential. A classifier task does not require a coding-agent adapter or agent
session. The first delivery targets Jev's System One API and demonstrates the
capability in an existing example workflow. Compatible providers can follow
without changing the authoring contract.

### requirement-discovery-and-autonomous-execution

Workflow is the public unit of discovery, reuse, composition, and execution.
Task sharing is not a separately versioned public plugin contract. Validate
dependencies before execution and reject ambiguous discovery names.
Runs proceed non-interactively to success, failure, or cancellation. Propagate
cancellation to active processes and agents where supported; report unavailable
capabilities and uncertain termination truthfully.

Native repository instructions, AGENTS files, skills, tools, plugins, MCP,
authentication, and permission settings remain authoritative in the selected
coding harness. Session forks do not merge. Workspace policy coordinates
ordering and compatibility; it does not grant tool permissions.

### requirement-standalone-cli-runs

`seqlane run` accepts one explicit file or installed package workflow without an
app, catalog, configuration file, or operational server. Normal trusted imports
remain supported. The operator selects `--adapter` only when agent work needs
one; Seqlane manages required adapter acquisition and cleanup. Native executables,
authentication, and permission configuration remain prerequisites.

Workflow model selection is authoritative. Unsupported models or settings fail
without substitution. Deterministic work starts no agent and makes zero model
calls. Standalone execution retains no Seqlane history, logs, recordings,
saved results, sessions, or artifacts. Intentional workflow outputs and
adapter-managed storage keep their existing ownership.

### requirement-operator-experience

Keep a focused CLI for planning, execution, progress, cancellation, and results.
Terminal output provides passive nested progress and elapsed run time without
keyboard input. CI provides permanent progress lines without terminal input.
Final JSON produces one result without progress output. Explicit output
selection and environment-safe defaults remain available.

Hosted run, result, event, and trace inspection is a separate explicit host
capability. It preserves identities across surfaces and remains usable after
restart. Launcher removal does not authorize losing hosted inspection.
Seqlane does not maintain a separate Studio application.

### requirement-run-output-quality

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

### requirement-distribution-and-maintenance

Distribute the CLI and authoring API through the public npm registry.
Supported local execution does not require an enterprise license or a hosted
service. Verify dependency licenses and security when dependencies change.
Keep engine and executor types behind private boundaries.

Remove each replaced implementation, dependency, export, fixture, asset, and
obsolete instruction when its production callers migrate. Temporary bridges
have explicit removal conditions and end before release. Measure production
code and dependency changes; a smaller tree alone does not prove parity.

## Constraints

The migration may change private implementation and dependencies. Any observable behavior change requires explicit documentation and evidence. Public and wire schemas remain Zod-owned; CLI commands and conventions remain Oclif-owned.

## Acceptance criteria

The active implementation spec and migration tasks define verifiable parity and removal evidence. This PRD does not claim runtime migration delivery.

## Traceability

- Supersedes [the earlier product requirements](./2026-09-02-seqlane.md).

- [brd.seqlane: Seqlane](../brd/2026-09-02-seqlane.md)
- [Full Effect v4 migration RFC](../rfcs/2026-10-21-effect-v4-migration.md)
- [Effect v4 execution and operations spec](../specs/2026-10-21-effect-v4-execution-and-operations.md)
