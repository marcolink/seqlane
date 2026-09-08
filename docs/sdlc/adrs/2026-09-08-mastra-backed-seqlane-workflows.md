---
id: adr.mastra-backed-seqlane-workflows
title: Center Seqlane Workflows on a Mastra-Backed Executable DSL
status: accepted
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - rfc.seqlane-technical-architecture
  - rfc.execution-observability-and-debugging
supersedes:
  - adr.effect-private-runtime-engine
  - adr.fluent-seqlane-flow-dsl
  - adr.executor-neutral-workflow-authoring
  - adr.seqlane-plan-ir-and-typed-dataflow
  - adr.consumer-agnostic-seqlane-execution-events
---

# Center Seqlane Workflows on a Mastra-Backed Executable DSL

## Context

Seqlane needs one authoring contract for tasks and workflows. The current
contracts split workflow definition, task factories, a Seqlane Plan, and an
Effect runtime. This split creates duplicate execution models.

Mastra is the only workflow engine for this design. Effect is not a second
engine and is removed from the runtime. Seqlane still owns authoring meaning,
serializable inspection, admission policy, session policy, runner boundaries,
and semantic observability.

## Decision

Seqlane will expose one fluent workflow API:

```ts
createFlow({ id, input, output })
  .task(name, runnable, binding, policy)
  .output(value)
  .define();
```

`defineTask` is the foundational task contract and requires `execute`.
`defineAgentTask` and `defineShellTask` create that same contract and supply
`execute`; callers cannot pass `execute` to those specialized factories.
Zod schemas define runtime input and output contracts. TypeScript types come
from those schemas.

The specialized factories describe a capability, not an executor product.
They must not expose Mastra, OpenCode, provider, client, or connection types.

A workflow is a runnable. Code that accepts a task or runnable also accepts a
workflow. Composition uses the same invocation and output contracts.

Seqlane owns a small, serializable, Mastra-independent Plan. Authors do not
build Plans directly. The Plan is the boundary between authoring, compilation,
runtime inspection, and serialization. It contains only these node kinds:

- task invocation;
- workflow invocation;
- the current validation check and validation gate nodes;
- bounded repeat.

The Plan does not become a second author API. Branch, choose, parallel,
foreach, retries, suspend or resume, persistence, and generic conditional
nodes remain out of this delivery.

The private runtime compiles the Seqlane Plan to Mastra. Mastra establishes
graph eligibility. Seqlane admission decides when eligible work starts. The
runtime preserves session reuse and branching, atomic admission, typed run
outcomes, and narrow runner notifications. Independent eligible nodes can run
concurrently. Admission policy still decides which eligible nodes can start.

The existing engine-neutral `@seqlane/core` runner-protocol boundary owns the
versioned Zod schemas and inferred types for runner notifications and
serialized run outcomes. The private runtime owns emission. The protocol has
one terminal serialized outcome per run and does not become a generic event
bus. `@seqlane/events` remains until consumer compatibility tests pass.

The first runtime cutover preserves observable behavior while retaining the
current dependency-aware concurrency. Dependencies establish eligibility;
Seqlane session and workspace admission determine actual starts. The
invocation kernel remains the shared place for task execution, policy
application, cancellation, cleanup, and typed errors.

Subprocess execution moves out of Effect in a separate slice. A shell task
uses an executable and argv array with direct spawn and `shell: false`. The
runtime owns the workspace, environment policy, timeout, output bounds,
cancellation, process-group cleanup, and typed errors.

Mastra observability carries a bounded allowlist of Seqlane semantic
attributes. Admission wait after dependencies are ready is a high-priority
signal. The CLI, output, Studio, recording, and replay behavior stay available
during this migration.

Bounded repeats accept a finite `maximumIterations` from 1 through 1,000. The
run-wide repeat-body budget is also 1,000 executions.

`@seqlane/events` is transitional. Consumers migrate to the replacement
notification and observability contracts before the package is deleted.

## Alternatives considered

### Keep Effect as the private workflow engine

Rejected. It keeps a second workflow model after Mastra is established and
duplicates cancellation, scheduling, and failure behavior.

### Expose Mastra workflows as the public API

Rejected. It would expose engine types, couple public contracts to Mastra, and
make serialized Plans depend on engine details.

### Remove the Seqlane Plan

Rejected. Seqlane needs a stable serializable boundary for inspection,
validation, policy, and migration. The Plan remains private to authoring and
runtime boundaries rather than a second author surface.

### Let Mastra decide admission

Rejected. Graph eligibility does not encode session, workspace, or atomic
admission policy. Seqlane must control the start boundary.

## Consequences

- Authors use one task and workflow vocabulary.
- Core remains free of Mastra types and dependencies.
- The runtime has one executable engine and one invocation kernel.
- Plan inspection remains stable and serializable.
- Independent eligible nodes retain dependency-aware concurrent execution.
- Effect code, packages, and imports are removed after the migration slices.
- Existing CLI, output, Studio, recording, and replay contracts require
  compatibility work during the consumer migration.
- Runner notifications and serialized outcomes have a separate versioned
  contract from Mastra observability.
- Shell tasks cannot parse workflow data as command strings.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.effect-private-runtime-engine: Use Effect as Seqlane's Private Runtime Engine](./2026-09-02-effect-private-runtime-engine.md)
- [adr.fluent-seqlane-flow-dsl: Provide a Fluent Seqlane Flow DSL](./2026-09-02-fluent-seqlane-flow-dsl.md)
- [adr.executor-neutral-workflow-authoring: Keep Workflow Authoring and Plans Executor-Neutral](./2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.seqlane-plan-ir-and-typed-dataflow: Use a Seqlane-Owned Plan IR with Typed Dataflow](./2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [adr.consumer-agnostic-seqlane-execution-events: Define Consumer-Agnostic Seqlane Execution Events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)
