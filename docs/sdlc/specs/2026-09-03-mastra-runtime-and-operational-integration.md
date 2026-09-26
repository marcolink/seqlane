---
id: spec.mastra-runtime-and-operational-integration
title: Mastra Runtime and Operational Integration
status: active
owners:
  - core
created: 2026-09-03
updated: 2026-09-26
upstream:
  - rfc.mastra-runtime-and-operational-foundation
  - adr.standalone-cli-runs
supersedes:
  - spec.effect-runtime-integration
  - spec.local-development-studio-trust-and-lifecycle
  - spec.local-read-only-execution-studio
  - spec.studio-vite-development-and-isolated-replay
  - spec.dedicated-runner-process
---

# Mastra Runtime and Operational Integration

## Summary

Seqlane compiles its coding-workflow model to Mastra and uses Mastra as its only
generic runtime and operational foundation. Seqlane retains the stable
coding-specific authoring, policy, identity, event, and CLI contracts.

This specification defines the target implementation contract. The migration is
delivered as a dependency-ordered stack of independently reviewable tasks.

## Goals

- Compile validated Seqlane workflows into Mastra workflows and steps.
- Preserve the public Seqlane DSL without exposing Mastra types.
- Use Mastra for execution, state, persistence, cancellation plumbing,
  processes, agents and ACP, tracing, server, MCP, and Studio.
- Preserve Seqlane session, workspace, identity, provenance, event, and CLI
  semantics where the product documents still require them.
- Remove each superseded implementation when its callers switch.

## Non-goals

- A pluggable abstraction for alternative workflow engines.
- Permanent compatibility adapters, dual runtimes, dual writes, or fallbacks.
- Mastra Enterprise Edition, Mastra Cloud, or hosted-service dependencies.
- Session-branch merging.
- A dedicated or rebranded Seqlane Studio.
- Delivery of the Renovate repair workflow, which is tracked independently.
- Unrelated public API redesign.

## Terminology

- **Normalized definition:** validated Seqlane-owned compiler input. It is not
  executable state or a persistence format.
- **Work:** the user's logical request.
- **Run:** the Mastra workflow-run attempt for a Work.
- **Invocation:** one Seqlane task represented by one Mastra step execution.
- **Migration bridge:** temporary code with named callers and an objective
  removal condition.

## Requirements

### requirement-single-runtime

Mastra must be the only generic workflow runtime. Seqlane must not retain a
parallel scheduler, retry engine, process supervisor, run store, trace store,
server, MCP transport, or Studio.

### requirement-public-boundary

Public/core modules, serialized definitions, Plans, runner IPC, stable CLI
results, and executor-independent contracts must contain no Mastra types,
objects, errors, configuration, or terminology.

### requirement-normalized-definition

Seqlane can retain a small, declarative normalized definition for validation
and compilation. It must not contain runtime state, scheduling state,
persistence state, or engine lifecycle behavior.

### requirement-step-correspondence

Each Seqlane task invocation must compile to one inspectable Mastra step.
Declared data dependencies and synthetic session/workspace ordering constraints
must be represented before the run starts.

### requirement-deterministic-process

A deterministic `shell()` invocation must run through a Mastra Workspace or
Sandbox process without constructing an agent or invoking a model. It must
normalize exit status, bounded output, timing, timeout, cancellation, task
identity, and invocation identity.

### requirement-agent-adapters

Agent tasks must use the selected private adapter. The runtime must select one
adapter before it creates a session or executes a task.

ACP implementations use the generic ACP adapter. OpenCode implementations use
the OpenCode SDK adapter. The runtime must not combine these adapters or use
one as an implicit fallback for the other.

### requirement-session-semantics

Isolated sessions are unique per invocation. Shared sessions are isolated by
Work and executor and never run concurrently. Branch sessions are independent,
can run concurrently, and never merge.

### requirement-workspace-constraints

Workspace policy controls compatibility and ordering, not tool authorization.
Static constraints must compile to graph structure. Dynamic admission is
permitted only when the constraint cannot be known before execution.

### requirement-identity-events

Work, Run, and Invocation identities must propagate through Mastra context or
metadata, steps, traces, executor calls, and normalized Seqlane events. The CLI
continues to consume the stable Seqlane event and result contracts.

### requirement-task-display-values

Task definitions and task factories do not expose an `observability` field.
The runtime emits full JSON inputs, validated results, and executor activity
values by default. It does not filter fields, truncate values, or suppress data
through task-level policy. JSON size, depth, and entry counts do not cause
replacement with summaries. Values that cannot satisfy the JSON event contract
remain unavailable; the runtime does not coerce them into partial JSON.
CI output and local event recordings, when enabled, preserve these values.
The human TUI retains complete recent records within its projection limits and
reports whole-record evictions. It does not redact or truncate retained values.
These local sinks can contain sensitive task data. Adapter observability
context remains a separate private runtime concern.

The runner event bridge limits queued and in-flight serialized events to 16 MiB
per run. It preserves accepted events and fails the run when the next event
would exceed the limit. The runner drains accepted events before it exits.
If normal IPC delivery fails, it waits for the queue to settle and tries to
send `run.failed` directly. If that fails too, it exits nonzero so the parent
can report the runner failure.

### requirement-storage-tracing

Mastra storage and tracing are canonical for hosted operational state.
Standalone runs retain runtime state in memory and create no durable copy.
Seqlane must not mirror complete run or trace state.

### requirement-server-mcp

Generic server and MCP behavior must use Mastra facilities. Seqlane may retain
only domain registration and thin translation required to expose workflows.

### requirement-workflow-discovery

Operators must be able to list and plan repository- and user-scoped workflows
without running workflow tasks. Discovery must preserve qualified scope, reject
ambiguous unqualified names, validate descriptors before import, and retain
direct module and file references. Repository and user workflow modules are
trusted internal code. `seqlane list` must not import workflow modules.
`seqlane plan` can import and evaluate a selected workflow module to compile its
Plan. It must not start a task, process, executor, model, or runtime. Seqlane
does not provide an untrusted-workflow sandbox.

`seqlane run` bypasses these catalogs. It accepts explicit file and package
entrypoints under [spec.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md).

### requirement-workflow-discovery-bounds

Workflow discovery must use explicitly configured depth, file, workflow-count,
and startup-time budgets. It must not follow a symbolic link outside a declared
root. It must report a typed limit or containment failure before registration.

### requirement-cli-operator-commands

The CLI must provide stable human and JSON commands to list, plan, run,
inspect, and cancel workflows. These commands validate transport data and do
not create a second runtime, run store, or trace store.

`seqlane run` accepts one explicit workflow file or package module entrypoint.
It does not resolve catalog names or descriptors. Each direct run uses one
dedicated runner child that loads the entrypoint and executes it through
in-memory Mastra runtime primitives. A direct run does not start or attach to a
Seqlane operational host, create durable Mastra storage, record run history,
generate a Seqlane recording, or write a GitHub summary.

The runner keeps the existing generic runtime-profile reference and adapter
configuration contract. The operator owns any configured OpenCode service and
its lifecycle, authentication, model availability, tools, and permissions.
`run` must not add adapter-selection flags, endpoint flags, per-run OpenCode
credentials, or adapter-service lifecycle management. Codex and ACP runtime
profiles remain supported.

### requirement-operational-host

`seqlane serve` owns one foreground Mastra host with registered workflows and
canonical server, MCP, storage, and trace surfaces. Studio can supervise or
connect to that host. Standalone `run` uses Mastra directly, creates no Seqlane
listener, and does not connect to this operational host.

### requirement-local-operational-access

Unauthenticated operational surfaces are local only. They bind to loopback,
and every configured host URL must be validated as `localhost`, `127.0.0.1`,
or `[::1]` before connection. Remote, multi-user, or non-loopback access needs
a separate authenticated authorization design.

### requirement-operational-data-bounds

Durable operational data must have an explicit retention and cleanup policy.
Run, storage, and trace reads must use bounded result sizes and continuation or
pagination. Cleanup must not remove an active run's required state.

### requirement-cross-surface-run

One hosted workflow run must retain the same Work and Run
identity when observed through the server, storage, traces, and Community
Studio. Each surface must read canonical Mastra state rather than a Seqlane
projection or copy. Standalone runs are excluded from hosted inspection and
retain no post-exit history.

### requirement-community-studio

`seqlane studio` must launch or connect to the upstream Mastra Community
Studio. The dedicated Seqlane Studio application, service, assets, and replay
implementation must be removed after callers switch.

### requirement-cancellation-errors

Cancellation must flow from the CLI or server to the Mastra run and active
agent/process operations where supported. Public failures must use stable
Seqlane categories and preserve the original cause without leaking Mastra
types.

### requirement-community-license

Only Community/open-source Mastra packages and paths are permitted. Imports or
copied code from `/ee/`, enterprise-only features, Mastra Cloud, and required
hosted services are prohibited.

### requirement-delete-replaced-code

Each task that switches the last production caller must also remove the
superseded code, tests, exports, dependencies, configuration, documentation,
assets, packages, and Nx projects in its scope.

## Detailed design and contracts

### Compiler pipeline

1. Load and resolve the workflow.
2. Validate identifiers, schemas, references, dependencies, sessions, and
   workspace policies.
3. Produce the normalized definition.
4. Add static session and workspace ordering edges.
5. Reject cycles and contradictory constraints.
6. Create one Mastra step per invocation.
7. Register and start the Mastra workflow with Work/Run metadata.
8. Normalize the final outcome for Seqlane consumers.

Compilation is pure and deterministic. Version-sensitive Mastra code stays in
the private integration layer.

### Task execution

Agent steps resolve the adapter, model, reasoning, session, and validated input
before they invoke the selected adapter. They validate and normalize output
before it enters Seqlane data flow.

Shell steps receive argv-based commands by default. Shell parsing is used only
when the public task explicitly requests shell semantics.

### Runtime ownership

Mastra owns scheduling, retry mechanics, canonical run state, persistence,
process execution, cancellation plumbing, tracing, server endpoints, MCP
infrastructure, and Community Studio integration.

Seqlane owns coding-specific validation and policy, normalized identities and
events, workflow discovery, the stable CLI, and public error/result contracts.

### Migration bridges

A bridge must identify every remaining caller, explain why it cannot switch in
the current task, define its removal condition, and name the next task that
removes it. No bridge may remain after the cleanup task.

## Failure and edge cases

- Missing Mastra capabilities fail explicitly before a workaround or dependency
  upgrade is introduced.
- Invalid definitions, cycles, or contradictory constraints fail before a run.
- Unsupported interaction requirements fail the autonomous run.
- Cancellation is idempotent and must not become a generic failure.
- Partial workspace mutations follow the surviving Seqlane workspace contract.
- A missing adapter capability fails preflight. The runtime must not route the
  request through a different adapter.
- Any enterprise-only import or dependency fails the architecture gate.

## Migration tasks

| Order | Task | Delivery branch |
| ---: | --- | --- |
| 0 | `task.mastra-migration-foundation` | `mastra` |
| 1 | `task.mastra-community-dependencies` | `mastra-01-community-dependencies` |
| 2 | `task.mastra-runtime-spine` | `mastra-02-runtime-spine` |
| 3 | `task.mastra-plan-compiler` | `mastra-03-plan-compiler` |
| 4 | `task.mastra-deterministic-shell` | `mastra-04-deterministic-shell` |
| 5 | `task.mastra-agent-acp` | `mastra-05-agent-acp` |
| 6 | `task.mastra-session-semantics` | `mastra-06-session-semantics` |
| 7 | `task.mastra-workspace-constraints` | `mastra-07-workspace-constraints` |
| 8 | `task.mastra-identity-events` | `mastra-08-identity-events` |
| 9 | `task.mastra-storage-tracing` | `mastra-09-storage-tracing` |
| 10 | `task.mastra-server-mcp` | `mastra-10-server-mcp` |
| 11 | `task.mastra-community-studio` | `mastra-11-community-studio` |
| 12 | `task.mastra-architectural-cleanup` | `mastra-12-architectural-cleanup` |
| 13 | `task.workflow-discovery-bounds` | `mastra-13-workflow-discovery-bounds` |
| 14 | `task.workflow-discovery-and-plan-cli` | `mastra-14-workflow-discovery-plan` |
| 15 | `task.operational-data-bounds` | `mastra-15-operational-data-bounds` |
| 16 | `task.mastra-operational-host` | `mastra-16-operational-host` |
| 17 | `task.cli-run-status-and-cancel` | `mastra-17-cli-run-control` |
| 18 | `task.mastra-mcp-transports` | `mastra-18-mcp-transports` |
| 19 | `task.mastra-studio-run-inspection` | `mastra-19-studio-run-inspection` |
| 20 | `task.mastra-operational-end-to-end` | `mastra-20-operational-end-to-end` |

Task dependencies and Traceability links define execution order. The index and
filename order are discovery aids only.

## Verification

Every implementation task runs its focused checks and the repository gate:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
pnpm docs:validate
git diff --check
```

Dependency changes also require lockfile synchronization, Community-license
review, and a repository search for forbidden `/ee/` imports.

## Acceptance criteria

- All supported workflows execute through Mastra.
- Agent and deterministic shell tasks preserve their public contracts.
- Shared sessions serialize, branches isolate, and workspace conflicts do not
  overlap.
- Work/Run/Invocation correlation is visible in normalized results and Mastra
  traces.
- Mastra owns canonical runtime state, server, MCP, and operational inspection.
- `seqlane studio` opens upstream Community Studio.
- No old runtime fallback, Effect orchestration, dedicated Studio, dual store,
  or unexplained migration bridge remains.
- The final task reports production-code, dependency, and Nx-project deltas.

## Traceability

- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
- [spec.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md)

- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
- [spec.agent-adapter-boundary-and-capabilities](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- Supersedes [spec.effect-runtime-integration](./2026-09-02-effect-runtime-integration.md).
