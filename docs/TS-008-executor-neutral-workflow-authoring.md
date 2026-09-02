# TS-008 — Executor-Neutral Workflow Authoring

**Status:** Implemented
**Implements:** ADR-008
**Depends on:** TS-003, TS-004, TS-005
**Scope:** Breaking MVP migration

## 1. Objective

Remove executor selection and implementation details from workflow source, Seqlane Plans, public contracts, runner IPC, CLI options, and documented configuration.

Workflow authors define generic Seqlane work. The private runner resolves that work to an executor.

```text
generic workflow source
        ↓
executor-neutral Plan
        ↓
private runner binding registry
        ↓
private executor adapter
        ↓
external execution environment
```

OpenCode remains an initial private adapter. It does not remain a workflow-authoring or Plan concept.

## 2. Normative Invariants

- `@seqlane/core` defines only executor-neutral authoring, schema, binding, reference, workflow, and Plan contracts.
- A `TaskDefinition` has no executor name, selector, connection, session, prompt, model, provider, tool, or permission field.
- A generic task declares agent-oriented goal, instructions, and references. It has input and output schemas without naming an executor, provider, endpoint, or client.
- An author uses `defineTask` and `defineWorkflow` from `@seqlane/core`. No public executor task factory exists.
- A serialized `Plan` has no executor field or executor configuration data.
- A `TaskNode` contains task ID, invocation ID, bindings, and dependencies only.
- The in-memory workflow build result retains generic task definitions for private runner resolution. It does not retain an executor binding.
- The runner resolves agent tasks to a private agent executor through a private registry after workflow loading.
- Executor bindings, capability adapters, clients, connection settings, sessions, prompts, structured-output formats, models, tools, permissions, and credentials remain private runtime state.
- A missing private binding fails the active invocation as a Seqlane executor failure. It does not cause workflow source fallback or executor discovery.
- `RunRequest`, CLI flags, and documented configuration use a generic runtime profile reference. They contain no OpenCode connection field or executor name.
- A workflow cannot choose a runtime profile, executor, or connection.
- `@seqlane/opencode` remains private and contains only adapter code. It exports no workflow-authoring factory or documented user-facing API.
- Fixtures and examples define generic tasks. Test-only private bindings can use fake executors or OpenCode adapters outside workflow source.
- Core and runtime public exports, serialized Plans, runner IPC, CLI help, and supported documentation contain no OpenCode, Mastra, provider, or executor implementation detail.
- Breaking changes are allowed. Compatibility aliases for executor-bearing task definitions, Plans, protocol fields, and CLI flags are not added.

## 3. Generic Authoring Contract

Core task definitions replace executor identity with an agent-oriented contract.

```ts
interface TaskDefinition<Input, Output> {
  readonly id: TaskId
  readonly input: SeqlaneSchema<Input>
  readonly output: SeqlaneSchema<Output>
  readonly goal: (input: Input) => string
  readonly instructions?: readonly string[]
  readonly references?: readonly string[]
}
```

`goal` is the task objective. `instructions` are static behavioral constraints.
`references` provide supporting context. None are provider settings or executor
controls. The MVP has no public operation, prompt, or GitHub task types.

For example, an author defines an agent task without an adapter import:

```ts
const summarize = defineTask({
  id: "change.summarize",
  input: changeSchema,
  output: summarySchema,
  goal: (change) => `Summarize change ${change.id}.`,
  instructions: ["Return only the requested summary."],
})
```

The definitions stay in memory. The Plan retains only task identity and dataflow. A core `TaskDefinitionRegistry` maps task ID to the in-memory generic definition for the loaded workflow.

The migration removes `opencode.task`, `structuredOutput`, OpenCode task types,
and executor identity from workflow source. A private agent adapter derives its
request format from the task definition and output schema.

## 4. Executor-Neutral Plan and Runtime Contract

The migrated node shape is:

```ts
interface TaskNode {
  readonly type: "task"
  readonly taskId: TaskId
  readonly nodeId: PlanNodeId
  readonly input: ValueBinding
  readonly dependsOn: readonly PlanNodeId[]
}
```

`buildWorkflow()` returns the Plan and the in-memory task definition registry. `compileWorkflow()` receives that registry plus private work resolvers.

The private resolver maps the agent task definition to a private agent executor.
Resolver types are not exported from a package root, Plan, workflow source,
runner protocol, CLI package, or configuration document.

```text
TaskNode.taskId
        ↓
in-memory TaskDefinitionRegistry
        ↓
private agent executor resolver
        ↓
private execution implementation
```

The runtime resolves bindings and validates input before it calls the resolved implementation. It validates output after the call as TS-001 defines.

## 5. Private Runtime Profile Resolution

The public runner request replaces `OpenCodeConnection` with a generic runtime profile reference.

```ts
interface RuntimeProfileReference {
  readonly id: string
}

interface RunRequest {
  readonly type: "run.start"
  readonly workflow: WorkflowReference
  readonly input: JsonValue
  readonly runtime: RuntimeProfileReference
}
```

The CLI accepts a generic required `--runtime` value and passes it unchanged to the runner. It does not accept `--opencode-url` or any executor-specific alternative.

The private runner resolves the runtime profile to agent bindings, operation capability adapters, and connection state. The profile implementation can select the OpenCode agent adapter in this MVP. Adapter configuration, endpoints, and credentials stay outside public contracts and supported user documentation.

Tests inject a private runtime profile resolver. This makes adapter behavior deterministic without adding executor details to workflow modules or runner IPC.

## 6. OpenCode Adapter Migration

`@seqlane/opencode` receives agent task definitions from the private resolver. It converts task metadata and the output schema to OpenCode requests internally.

The adapter continues to own SDK compatibility, session creation, request serialization, structured output, interaction failure, and cancellation. It does not export `opencode.task`, `structuredOutput`, task-definition types, runner-execution factories, or connection types for workflow authors.

The adapter can use a private schema conversion for the MVP. A schema that cannot support the required private structured-output request fails at private binding preparation or execution. The failure does not add OpenCode metadata to core contracts.

## 7. Migration Surfaces

The implementation must update these surfaces together:

- core task definitions, Plan nodes, Plan validation, build results, and type tests
- runtime execution context, compiler, agent and operation resolvers, workflow loader, and runner setup
- core runner protocol and CLI command parsing
- OpenCode package exports, adapter binding, and package README
- Renovate workflow, fake workflow, fixtures, and all executor-dependent tests
- `docs/TS-003-seqlane-plan-ir-typed-dataflow.md`
- `docs/TS-004-opencode-executor-integration.md`
- `docs/MVP.md`
- `docs/ADR-006-repository-user-workflow-discovery-and-composition.md`
- package READMEs, CLI examples, and architecture index

Do not rewrite accepted ADRs. ADR-004 remains the private adapter decision. ADR-008 supersedes its workflow-authoring portion.

## 8. Required Tests

Tests must prove:

- generic agent and operation authoring preserve input, output, `ValueRef`, and input-binding type inference
- Plans serialize without executor identity or adapter configuration
- core and public runtime exports contain no OpenCode, Mastra, SDK, provider, or executor implementation type
- private resolution maps agent work and operation capabilities separately, and reports missing mappings as executor failures
- the runner request accepts a generic runtime profile and rejects OpenCode-specific fields
- CLI help and parsing expose `--runtime` but not `--opencode-url`
- a generic authored Renovate workflow runs through the private OpenCode agent binding
- a mixed agent and operation workflow runs through private fake bindings
- private OpenCode structured output, interaction failure, and cancellation behavior remain covered
- documented user-facing workflow and CLI examples contain no executor implementation names

Use static source and export checks in addition to runtime tests. The source checks must inspect public packages, workflow fixtures, Plans, runner IPC, CLI help, and documentation. They may exclude private adapter implementation files and adapter-specific test servers.

## 9. Acceptance Criteria

TS-008 is complete when:

- workflow authors use only generic core task and workflow contracts, including `agent` and `operation` work kinds
- Plans and Plan validation contain no executor field or executor configuration
- private runtime bindings resolve agent work and operation capabilities without workflow participation
- runner IPC and CLI use a generic runtime profile without OpenCode fields or flags
- OpenCode remains functional as a private adapter for generic workflows
- generic workflows run with a fake binding and the private OpenCode binding
- fixtures, examples, package exports, and supported documentation contain no executor implementation detail at public boundaries
- static boundary tests prevent future OpenCode or Mastra leakage
- all workspace quality gates pass

## 10. Explicitly Deferred

TS-008 does not implement:

- workflow-level executor selection or fallback
- a public executor registry or plugin API
- a public operation-adapter registry, endpoint, client, or authentication contract
- multiple runtime profiles as a workflow authoring feature
- provider, model, tool, session, or permission authoring controls
- a user-facing OpenCode configuration format
- managed OpenCode lifecycle, new executor implementations, or executor discovery
- a general schema-conversion contract beyond private adapter needs
- changes to historical ADR text except explicit status or lifecycle notes

## 11. Delivery Order

1. Replace executor-bearing core task and Plan contracts with generic agent and operation work kinds.
2. Add private agent and operation resolvers plus the generic runtime profile protocol.
3. Move OpenCode request construction behind the private agent binding.
4. Migrate the CLI, workflows, fixtures, and tests.
5. Update related technical documents and add boundary regression checks.
