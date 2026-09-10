---
id: rfc.mastra-runtime-and-operational-foundation
title: Mastra as Seqlane's Runtime and Operational Foundation
status: accepted
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - prd.seqlane-on-mastra
supersedes:
  - rfc.seqlane-technical-architecture
  - adr.effect-private-runtime-engine
---

# Mastra as Seqlane's Runtime and Operational Foundation

## Abstract

Seqlane will compile its coding-workflow DSL to Mastra and will remove its competing generic runtime infrastructure. Seqlane keeps the domain contract—authoring API, task kinds, sessions, workspace policy, Work identity, provenance, executor configuration, and CLI. Mastra owns the mechanisms for workflow execution, graph scheduling, run state, persistence, retries, cancellation plumbing, agents and ACP, workspaces and sandboxes, process execution, tracing, server APIs, MCP, and Studio.

The migration is intentionally destructive. The target is one runtime with a thin Seqlane translation and policy layer, not two runtimes joined by compatibility adapters.

## Context

Seqlane exists to make software-engineering workflows explicit, composable, typed, and repeatable. Its differentiation is the coding-workflow model, not generic orchestration infrastructure.

Mastra now supplies the capabilities that previously justified substantial Seqlane-owned infrastructure, including TypeScript workflow primitives, agent integration, ACP support, workspaces and sandboxes, process execution, storage, tracing, server endpoints, MCP, and Studio. Keeping both implementations increases maintenance cost and forces contributors to decide which system is authoritative.

## Decision

Mastra is the sole generic runtime for Seqlane.

Seqlane exposes a stable, coding-specific DSL and compiles it into a Mastra execution graph. Seqlane may wrap Mastra at the integration boundary, but it must not recreate a generic scheduler, run store, retry engine, server, MCP server, tracing backend, process supervisor, or Studio.

The boundary is asymmetric:

- Mastra types may exist inside the compiler and runtime integration.
- Mastra types must not leak into the stable workflow-authoring API, serialized Seqlane definitions, CLI result contract, or executor-independent domain types.
- Seqlane semantics are translated into Mastra configuration and graph structure before execution wherever possible.

## Responsibility model

| Capability | Seqlane owns | Mastra owns |
| --- | --- | --- |
| Workflow DSL | Public authoring API and coding-specific semantics | Execution representation |
| Schemas and data flow | Public input/output contracts and reference validation | Step schema/runtime enforcement where usable |
| Graph | Dependency intent plus session/workspace constraints | Scheduling and execution |
| Agent task | Task contract, prompt/input construction, executor selection | Agent/ACP invocation machinery |
| Shell task | Deterministic task contract and result normalization | Workspace/Sandbox process execution |
| Sessions | `isolated`, `shared`, and `branch` semantics | Runtime thread/session mechanisms |
| Workspaces | Compatibility and serialization policy | Filesystem, sandbox, and process primitives |
| Identity | Work and Invocation semantics; provenance | Run and step identifiers/mechanisms |
| State/persistence | Product-level metadata contract | Canonical run state and storage |
| Retries | Public policy, if exposed | Retry mechanism |
| Cancellation | Product behavior and normalized outcome | Workflow/agent/process cancellation plumbing |
| Observability | Seqlane event names needed by the CLI | Trace storage and inspection |
| Server and MCP | Seqlane-specific adapters or registration only | Generic server and MCP infrastructure |
| Studio | `seqlane studio` launcher | Upstream Community Studio |
| CLI | Commands and user experience | Runtime APIs used by commands |

## Public model

The public DSL retains these concepts:

- `workflow()` — the public unit of discovery, reuse, composition, and execution;
- `task()` — agentic work executed by a configured coding executor;
- `shell()` — deterministic process execution with no model call;
- input and output schemas;
- dependency/data references;
- session selection: isolated, shared, or branch;
- workspace access policy;
- executor/model/reasoning configuration;
- Work identity and provenance.

Tasks remain implementation details of a workflow in V1. This avoids creating a second public plugin/versioning surface while still allowing ordinary code reuse inside a workflow package.

## Compilation model

Compilation is a pure, testable transformation from a validated Seqlane definition to a Mastra workflow registration.

| Seqlane concept | Mastra target |
| --- | --- |
| `workflow()` | Registered Mastra workflow |
| `task()` | Mastra step invoking an agent/ACP executor |
| `shell()` | Mastra step invoking a Workspace/Sandbox process |
| `dependsOn` | Mastra graph dependency |
| Task input/output schemas | Mastra step schemas plus Seqlane boundary validation |
| Work | Workflow run plus Seqlane metadata/context |
| Invocation | Step execution plus Seqlane metadata |
| Shared session | Stable runtime thread/session key |
| Branched session | New runtime thread/session derived from the declared parent where supported |
| Workspace policy | Additional graph edges or admission constraints |

### Compiler stages

1. Load and resolve the workflow.
2. Validate unique identifiers, schemas, references, dependencies, session declarations, and workspace policies.
3. Build a Seqlane-owned normalized definition. This is a small compiler input model, not an executable runtime or persisted engine state.
4. Add ordering edges required by shared-session and workspace constraints.
5. Detect cycles and contradictory constraints before invoking Mastra.
6. Create one Mastra step per Seqlane task invocation.
7. Register the Mastra workflow and attach Work/Invocation metadata.

The normalized definition must contain only data necessary for validation and compilation. It must not grow into a second scheduler, state machine, or persistence format.

## Task execution

### Agent tasks

An agent task step:

1. resolves and validates its input;
2. resolves the declared executor, model, provider, and reasoning configuration;
3. resolves its session identity;
4. invokes a Mastra-supported coding-agent or ACP primitive;
5. preserves the harness's repository instructions and capabilities;
6. validates and normalizes the result into the declared output schema;
7. emits Seqlane CLI events backed by Mastra run/trace data.

OpenCode is the initial executor. ACP is preferred because it keeps Seqlane on Mastra's integration path. Native OpenCode server APIs are allowed only for a named capability gap and must stay behind the executor adapter.

### Shell tasks

A shell task is a normal Mastra step that executes a process in the selected Mastra Workspace/Sandbox. It must not construct an agent, invoke a model, or consume AI tokens.

The normalized result should include, at minimum:

- exit status;
- stdout and stderr according to the configured capture/streaming policy;
- start/end timing;
- cancellation or timeout outcome;
- the task and invocation identity.

Commands execute without an intermediate shell unless shell semantics are explicitly requested. This prevents accidental quoting differences and makes the command contract testable.

## Session semantics

Seqlane owns the public semantics; Mastra supplies the underlying memory/thread/session mechanism.

### Isolated

The default. Each task invocation receives a distinct session identity.

### Shared

Tasks that declare the same shared session reuse context. They must never execute concurrently. The compiler adds ordering constraints even when the data-dependency graph would otherwise allow parallel execution.

A logical shared-session key is derived from:

```text
(workId, sessionName, executor)
```

The runtime may encode this differently, but isolation between Works and executors is mandatory.

### Branch

A branch receives an independent session derived from a declared parent point and may run concurrently with other branches. Branches are never merged. Downstream task inputs may combine their typed outputs, but their conversational histories remain separate.

If the chosen Mastra/executor primitive cannot fork context directly, the adapter may seed a new session from the parent's available history. That is an executor-specific bridge, not a general Seqlane session store.

## Workspace policy

Workspace policy defines safe execution ordering, not tool authorization.

- A shared task may overlap with other compatible shared tasks.
- An exclusive task must not overlap with any other task using the same workspace.
- Tasks using the same shared session are serialized regardless of workspace mode.
- The compiler should express static constraints as graph edges.
- Dynamic admission control may be used only when the constraint cannot be known statically and must use Mastra-compatible mechanisms rather than a parallel scheduler.

Actual file/tool permissions belong to runtime and executor configuration. Seqlane does not reintroduce per-task permissions in this migration.

## Identity and provenance

Seqlane retains the product concepts:

- **Work:** the user's logical request across an execution;
- **Run:** the Mastra workflow-run attempt that executes the Work;
- **Invocation:** one task/step execution within a Run.

Work identity is carried in Mastra request context or metadata and propagated into steps, traces, normalized events, and executor calls. Mastra identifiers are retained for correlation but do not replace the stable Seqlane identity contract.

Git commit trailers or other provenance written by workflows may reference Work, Run, and Invocation identities. Provenance formatting remains a Seqlane concern; storage of generic run state does not.

## Persistence, retries, cancellation, and errors

- Mastra storage is canonical for runtime state. Do not mirror full run state in Seqlane.
- If Seqlane exposes retry policy, compile it to Mastra. Do not implement a second retry loop around a Mastra workflow.
- The default remains no implicit semantic repair loop unless the workflow explicitly declares one.
- Cancellation flows from CLI/server to the Mastra run and then to active agent/process operations where supported.
- Integration errors are normalized at the Seqlane boundary into stable categories such as definition, executor, process, cancellation, timeout, and internal integration errors.
- Preserve the original error as a cause for debugging without exposing unstable Mastra types in public results.

## Server, MCP, observability, and Studio

### Server and MCP

Use Mastra's server and MCP facilities. Seqlane contributes only domain-specific registration, metadata, and thin adapters required to expose workflows. Existing generic Seqlane servers and MCP transports are deleted after callers switch.

### Observability

Mastra tracing and run storage are the implementation source for operational inspection. Seqlane keeps only the small semantic event contract necessary for stable CLI output and external consumers. Do not maintain a parallel trace tree or event database.

### Studio

Delete the dedicated Seqlane Studio application. `seqlane studio` starts or connects to the Seqlane/Mastra runtime and launches the upstream Mastra Community Studio.

Seqlane-specific metadata should improve the information shown in Studio through supported Mastra extension/metadata points. It must not require a fork or rebranding.

## Effect usage

Effect is not an orchestration layer in the target architecture. Remove Effect-based workflow execution, lifecycle, scheduling, retry, and service graphs replaced by Mastra.

Effect may remain in a low-level adapter only when it provides clear local value and does not impose Effect types or runtime requirements on the public DSL or Mastra integration. The default migration decision is removal, not preservation.

## Package and dependency boundaries

Fit these logical boundaries to the repository's current Nx/package layout; do not preserve a package solely because it already exists.

1. **Core/public:** DSL, schemas, normalized definition, validation, identity, and executor-independent contracts. No Mastra dependency.
2. **Mastra integration:** compiler, registration, runtime configuration, storage/tracing adapters, server/MCP wiring, and Studio launcher integration.
3. **Executor adapters:** OpenCode/ACP configuration and any narrow native escape hatches.
4. **CLI:** discovery, plan display, run/cancel/status, normalized rendering, and `studio` launcher.

Collapse or delete packages that become forwarding-only or empty. Avoid a generic `runtime` abstraction designed to support hypothetical non-Mastra engines; Mastra is the chosen runtime.

## Licensing constraints

Mastra uses a dual-license repository model: its core is Apache-2.0, while code under `ee/` is governed by the Mastra Enterprise License. Seqlane therefore:

- uses Community/open-source packages and paths only;
- prohibits imports from paths containing `/ee/`;
- does not require licensed authentication, RBAC, or other enterprise features;
- does not require Mastra Cloud;
- launches the upstream Community Studio rather than distributing a modified or rebranded Studio;
- reviews the license boundary on every Mastra upgrade.

This constraint should be enforced with dependency review, license scanning where practical, and a repository search for forbidden imports.

## Migration plan

### Phase 0 — Inventory and deletion map

- Enumerate public API, packages, Nx projects, runtime services, server/MCP code, Studio code, persistence, tracing, Effect services, tests, and dependencies.
- Classify each item as **keep**, **rewrite as thin Seqlane policy**, **replace with Mastra**, or **delete**.
- Record callers and a deletion condition for every temporary bridge.

Exit: every current runtime responsibility has a target owner and deletion decision.

### Phase 1 — Mastra spine

- Add/pin Community Mastra dependencies.
- Introduce the narrow Mastra integration boundary.
- Configure storage, tracing, server/runtime registration, and test fixtures.
- Add dependency-boundary and license checks.

Exit: a minimal compiled workflow runs through Mastra without the old engine.

### Phase 2 — Compiler and deterministic tasks

- Validate the Seqlane DSL into the normalized definition.
- Compile graph dependencies and schemas.
- Implement `shell()` as a Mastra Workspace/Sandbox process step.
- Switch representative deterministic callers.
- Delete the replaced process/runtime paths and their stale tests/dependencies.

Exit: deterministic workflows run with zero model invocations and no fallback runtime.

### Phase 3 — Agent tasks and OpenCode

- Implement agent steps through Mastra ACP/coding-agent primitives.
- Map model/provider/reasoning and structured-output contracts.
- Preserve repository harness context.
- Add cancellation and normalized telemetry.
- Use native OpenCode APIs only for documented gaps.
- Delete or radically shrink the current OpenCode adapter rather than wrapping it unchanged.

Exit: the representative coding workflow runs without the former agent runtime path.

### Phase 4 — Sessions and workspaces

- Implement isolated/shared/branch identity mapping.
- Add serialization edges for shared sessions.
- Compile workspace compatibility constraints.
- Test parallel-safe and conflicting graphs plus cycle detection.
- Delete the old session/workspace scheduler and stores.

Exit: session and workspace semantics pass concurrency tests on the Mastra runtime.

### Phase 5 — Operational surface

- Move persistence and traces fully to Mastra.
- Replace generic Seqlane server and MCP implementations with Mastra registration.
- Implement `seqlane studio` as a Community Studio launcher.
- Preserve only the normalized CLI event/result contract.
- Delete the dedicated Studio and obsolete operational infrastructure.

Exit: CLI, server, MCP, tracing, persistence, and Studio all operate on one Mastra run.

### Phase 6 — Architectural cleanup

- Remove temporary bridges, compatibility exports, dead modules, stale tests, unused dependencies, empty packages, obsolete Nx projects, docs, and configuration.
- Search the repository for old symbols and architecture language.
- Re-run public API, dependency-boundary, license, lint, typecheck, test, and end-to-end checks.
- Report code/dependency/project deltas.

Exit: no dual runtime or superseded implementation remains.

## Testing strategy

### Contract tests

- DSL types and schemas remain stable.
- Invalid references, cycles, and incompatible constraints fail before execution.
- Public exports contain no accidental Mastra types.

### Compiler tests

- One task invocation produces one Mastra step.
- Data dependencies and synthetic session/workspace edges are correct.
- Compiled step identifiers and metadata are deterministic.

### Runtime integration tests

- Agent and shell tasks normalize success, failure, timeout, and cancellation.
- Shell execution performs no model call.
- Shared sessions serialize and reuse context.
- Branches isolate context and never merge.
- Workspace conflicts do not overlap.
- Work/Run/Invocation correlation appears in results and traces.

### Architectural tests

- Core/public modules do not depend on Mastra.
- No import path contains `/ee/`.
- Removed runtime, Studio, persistence, server, MCP, tracing, and Effect symbols are absent.
- No production dependency exists solely for deleted infrastructure.

### End-to-end tests

- A representative workflow is executed by OpenCode, verified by deterministic commands, and reported through the CLI. The Renovate workflow is delivered independently.
- The same run is inspectable through upstream Mastra Community Studio.

## Completion criteria

The migration is complete only when:

1. all supported workflows execute through Mastra;
2. no old engine fallback or dual-write path exists;
3. all superseded code, tests, exports, dependencies, packages, Nx projects, docs, and Studio assets are removed;
4. public API and executor boundaries are enforced by tests;
5. the representative end-to-end workflow passes;
6. `seqlane studio` launches the upstream Community Studio;
7. no Enterprise Edition or hosted-service dependency is required;
8. the migration PR includes a deletion/delta report.

## Rejected alternatives

### Keep the existing runtime and use Mastra selectively

Rejected because it preserves duplicate schedulers, state models, observability, and maintenance paths.

### Wrap the old runtime behind a Mastra step

Rejected because Mastra would become decorative while Seqlane continued to own the hard runtime problems.

### Generalize a pluggable runtime abstraction

Rejected for now. Supporting hypothetical engines would keep the abstraction and code footprint this migration is intended to remove.

### Maintain a dedicated Seqlane Studio

Rejected for V1. The upstream Community Studio provides the operational surface without another application to build and maintain.

## Upgrade discipline

Mastra APIs are version-sensitive. Contributors must verify every touched API against the repository's pinned dependency, installed type declarations/source, and current official documentation. Examples from memory, blogs, or a different version are not sufficient. Upgrade Mastra intentionally and rerun compiler, architectural, integration, Studio, and license checks.

## References

- [Mastra repository and license overview](https://github.com/mastra-ai/mastra)
- [Mastra Enterprise Edition license boundary](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)
- [Mastra ACP announcement](https://mastra.ai/blog/introducing-agent-client-protocol)
- [Mastra workspace and remote sandbox overview](https://mastra.ai/blog/introducing-remote-sandboxes)


## Traceability

- [prd.seqlane-on-mastra: Seqlane on Mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- Supersedes [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](./2026-09-02-seqlane-technical-architecture.md).
- Supersedes [adr.effect-private-runtime-engine: Use Effect as Seqlane's Private Runtime Engine](../adrs/2026-09-02-effect-private-runtime-engine.md).
