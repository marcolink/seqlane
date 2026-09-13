---
id: spec.runtime-resolved-execution-profiles
title: Runtime-Resolved Agent Profiles
status: draft
owners:
  - core
created: 2026-09-02
updated: 2026-09-13
upstream:
  - adr.runtime-resolved-execution-profiles
supersedes: []
---

# Runtime-Resolved Agent Profiles

> Migrated from legacy technical specification `TS-018`.

## 1. Objective

Allow a workflow and its tasks to select reusable agent profiles without
putting provider, gateway, model, tool, permission, or OpenCode data in
workflow source or serialized Plans.

The runtime resolves each logical agent key against the active runtime
configuration. It validates the complete setup before it creates an OpenCode
session. It reports safe model changes as canonical warning events. It fails
when a profile change needs a new session or another unsupported side effect.

```text
workflow/task agent key
              ↓
runtime agent registry
              ↓
resolved adapter agent setup
              ↓
OpenCode session and prompts
```

## 2. Normative Terms

- **Agent key:** A non-empty string in workflow or task source. It names a
  runtime-owned agent profile.
- **Agent profile:** A runtime configuration entry that selects a complete
  agent setup for an adapter.
- **Resolved profile:** A validated profile for the run's selected adapter,
  with its OpenCode target, model identity, gateway identity, and runtime-native
  configuration.
- **Workflow default:** The agent key on a workflow definition.
- **Task override:** The agent key on a task definition. It overrides the
  workflow default for every invocation of that task.
- **Runtime default:** The agent selected when neither the workflow nor the
  task defines an agent key.
- **Preflight:** Static and live validation that runs before OpenCode session
  creation.
- **Session-safe transition:** An agent profile change that the active adapter can
  apply in the current session without changing session-scoped behavior.
- **Unsupported transition:** An agent profile change that needs a new session or a
  session mutation that the adapter cannot prove safe.

The words **model**, **profile**, **adapter**, and **gateway** keep one meaning
in this specification. A model is not an agent profile. A model is one property
inside a resolved profile.

## 3. Invariants

- Workflow and task source contains only an opaque agent key.
- Direct provider or model IDs are not valid workflow or task configuration in
  the first iteration.
- A serialized Plan contains no agent key, profile, model, tool, gateway,
  OpenCode, or executor value.
- A task agent key overrides a workflow agent key. An omitted task key inherits the
  workflow key.
- An omitted workflow and task key use the runtime default agent.
- An agent profile is a complete agent setup. The first iteration has no policy
  overlay or profile merge operation.
- A runtime agent registry is local to one runtime configuration. The same
  key can resolve to a different setup in another runtime configuration.
- Agent keys are exact and case-sensitive. The runtime does not trim,
  normalize, or change key case.
- Empty agent keys and keys with leading or trailing whitespace are
  invalid.
- Every referenced agent must resolve before task execution starts.
- Static profile validation and live gateway/model validation are separate
  checks. Both are mandatory.
- All preflight failures are aggregated before the run reports the failure.
- The first iteration creates one OpenCode session per Seqlane Run.
- Each Run already has one adapter selected by the existing CLI/runtime
  mechanism. This specification does not add or change CLI commands, flags, or
  runtime selection interfaces. The adapter remains immutable for the complete
  Run.
- The runtime never creates a replacement session as an implicit fallback.
- A safe model-only transition can continue in the same session and emits an
  warning.
- An unsafe or unsupported transition fails before the affected task runs.
- Warnings use stable codes and structured fields. Consumers do not parse
  warning message text.
- The CLI and Studio consume the same canonical warning events.
- Credentials, gateway secrets, prompts, raw OpenCode config, and resolved
  provider objects do not cross the runner boundary or enter events.

## 4. Scope

### In scope

- Optional `agent` keys on workflow and task definitions.
- Runtime-owned agent profile registry.
- OpenCode adapter target resolution for an OpenCode-selected Run.
- Exact, pinned OpenCode configuration validation.
- Static profile and dependency validation.
- Live gateway/model availability validation.
- Profile precedence and duplicate-definition checks.
- Single-session transition classification.
- Structured warning events.
- CLI and Studio warning projection.
- Compatibility for workflows that omit agent keys.

### Out of scope

- Direct model IDs or model keys in workflow or task source.
- Per-task tool or permission overlays.
- Merging or patching OpenCode configuration from workflow source.
- Multiple OpenCode sessions in one Run.
- Implicit session restart, session fork, summarization, or context handoff.
- Explicit session-boundary syntax. A later ADR will define it.
- Dynamic agent keys returned by task output or runtime callbacks.
- Executor-neutral capability requirements such as `long-context` or
  `supports-shell`.
- OpenTelemetry or CloudEvents warning adapters.
- Changes to the existing adapter-selection CLI/runtime interface.

## 5. Authoring Contract

Add an optional agent key to the generic workflow and task contracts.
Conceptually:

```ts
interface TaskDefinition<Input, Output> {
  readonly id: TaskId;
  readonly agent?: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly goal: (input: Input) => string;
}

interface WorkflowDefinition<Input, Output> {
  readonly id: string;
  readonly agent?: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly build: WorkflowBuilder<Input, Output>;
}
```

The exact public type name for an agent key can remain a string alias. The
core package must not import runtime profile, OpenCode, provider, or gateway
types.

Example:

```ts
const inspectTask = defineTask({
  id: "inspect",
  agent: "read-only-coding",
  input: inspectInput,
  output: inspectOutput,
  goal: (input) => `Inspect ${input.repository}`,
});

const workflow = defineWorkflow({
  id: "release-doctor",
  agent: "coding",
  input: workflowInput,
  output: workflowOutput,
  build: ({ input, run }) => run(inspectTask, { input }).output,
});
```

The task uses `read-only-coding`. Other tasks use `coding` unless they define
their own key. The key names do not promise a model, provider, gateway, tool,
or runtime authority.

### Key validation

Core validates key shape during definition or build validation:

- value is a string;
- value is not empty;
- value is not whitespace-only;
- value has no leading or trailing whitespace.

Core does not validate whether the key exists in a runtime registry. Runtime
preflight owns that check.

### Missing values and inheritance

`undefined` means “inherit”. `null` is invalid. An empty string is invalid.
There is no first-iteration syntax to clear a workflow agent key for one
task and return to the runtime default. Authors must define a separate runtime
profile for that behavior.

### Duplicate task identities

One built workflow must have one canonical task definition for each task ID.
If the same task ID is registered with different agent keys, build-time
validation fails. The runtime cannot select an agent key by invocation
when the task registry is keyed only by task ID.

The same task definition can be invoked more than once. Each invocation uses
the definition's one agent key.

### Validators and repeats

- A mechanical validator has no agent profile and uses no executor.
- A task-backed validator uses its task definition's agent key.
- A repeat body task uses its task definition's agent key on every
  iteration.
- A repeat body cannot compute a new agent key from repeat state.
- An uninvoked task definition is not a workflow agent requirement.

## 6. Runtime Configuration

The private runtime owns a configuration that contains a profile registry and
an adapter configuration block.

### Configuration selection and formats

The CLI accepts an optional `--config <path>` flag. When the flag is absent,
the CLI uses Cosmiconfig's asynchronous `search` API with an explicit search
list containing only:

1. `seqlane.config.json`
2. `seqlane.config.ts`

The CLI resolves the selected path to an absolute path and passes only that
path to the runner over IPC. It never sends the parsed configuration or its
secrets. The runner loads the selected file with Cosmiconfig's asynchronous
`load` API, then validates the loaded value with the runtime configuration
schema before resolution.

The CLI and runner must not search or load other Cosmiconfig defaults,
including RC, YAML, TOML, JavaScript, or package-property configuration. JSON
is parsed as a JSON object. TypeScript is loaded as a module and must provide
the config object as its default export.

The TypeScript file is trusted executable code. Configuration loading must not
execute a file selected from an untrusted workflow or repository boundary.

Conceptual shape:

```ts
interface RuntimeAgentConfig {
  readonly agents: Readonly<Record<string, RuntimeAgentProfile>>;
  readonly defaultAgent?: string;
  readonly opencode: OpenCodeConfiguration;
}

interface RuntimeAgentProfile {
  readonly agent: string;
}
```

The external configuration uses JSON objects, not `Map` values:

```json
{
  "agents": {
    "coding": {
      "agent": "build"
    }
  },
  "defaultAgent": "coding",
  "opencode": {
    "...": "the exact pinned OpenCode configuration schema"
  }
}
```

The `opencode` object is passed to OpenCode using its exact pinned schema. The
placeholder above is illustrative only; Seqlane does not define a parallel
schema or flatten that object.

The exact private type can change. The following rules do not change:

- `agents` maps Seqlane agent keys to targets interpreted by the selected
  adapter.
- `defaultAgent` is used when neither workflow nor task specifies `agent`.
- For an OpenCode-selected Run, the adapter target is an OpenCode agent. The outer `agents` property
  names the logical Seqlane key; the nested `agent` property names the
  OpenCode target.
- The OpenCode agent owns the model, tools, runtime-native permission
  configuration, and related OpenCode behavior.
- `opencode` is validated against the pinned OpenCode configuration schema.
- Seqlane does not define a second OpenCode configuration schema.
- Secrets use the runtime's existing secret and environment mechanism. They do
  not appear in workflow source, runner commands, Plans, events, or errors.
- Agent entries do not contain an adapter discriminator; the run's existing
  adapter selection applies to every entry.
- Cosmiconfig is a direct CLI/runtime dependency. The CLI uses its async
  `search` API and the runner uses its async `load` API.

The runtime can use different registries for different runs. Agent keys are
not global names and do not need to resolve to the same OpenCode agent in all
environments.

### Agent target validation

For every referenced profile, runtime validation checks:

- agent key exists;
- the selected adapter is installed and enabled;
- for an OpenCode-selected Run, the OpenCode agent target exists in the
  OpenCode configuration;
- the agent model exists in the configured provider/model catalog;
- required tools exist in the active OpenCode tool catalog;
- gateway/provider references are configured; and
- the profile has no unsupported Seqlane-specific fields.

The adapter owns provider-specific checks. Core never inspects these fields.

### OpenCode configuration lifecycle

The runtime gives the validated OpenCode configuration to the private adapter
at session setup. The adapter applies it at the earliest lifecycle point that
the active OpenCode mode supports.

If the active OpenCode mode cannot accept the configuration at session setup,
the runtime fails preflight. It must not silently ignore the block or apply a
different configuration.

An externally managed OpenCode server can own its process configuration. In
that mode, the adapter validates that the server is compatible with the
requested block. Server startup and credential management remain outside
Seqlane until a later managed-runtime decision.

## 7. Resolution and Preflight

### Resolution precedence

For each executable task invocation, resolve the key in this order:

1. task definition `agent`;
2. workflow definition `agent`;
3. runtime `defaultAgent`.

If no key is available after step 3, preflight fails with
`missing-runtime-default`. A runtime must not silently choose an adapter
default for a workflow that has no valid agent setup.

### Preflight phases

Run these phases in order:

#### Phase 1: Load and parse runtime configuration

- Receive the config path selected or discovered by the CLI in the private
  runtime reference.
- Load the selected file with Cosmiconfig's asynchronous `load` API; do not
  perform a second discovery search.
- Parse the runtime configuration as untrusted input.
- Reject malformed structures, duplicate conflicting agent entries, invalid
  keys, and invalid OpenCode configuration.
- Do not create an OpenCode session.

#### Phase 2: Load and build the workflow

- Load the workflow export.
- Build the workflow and Plan.
- Collect the workflow agent key.
- Collect agent keys from every registered task used by the Plan.
- Collect task-backed validator definitions and repeat-body task definitions.
- Keep all collected definitions in memory. Do not add them to the Plan.

#### Phase 3: Resolve profile references

- Resolve each distinct key once.
- Keep every source reference for error reporting.
- Resolve the runtime default when required.
- Produce a private resolved-profile record for each executable Plan node.
- Do not resolve profiles for mechanical validators.

#### Phase 4: Validate static dependencies

- Validate the selected adapter and its agent targets.
- Validate model, tool, and gateway references.
- Validate that the adapter can request structured output for every task that
  has an output schema.
- Validate that required agent and tool behavior matches the task's runtime
  contract.
- Aggregate all issues by workflow, task, and Plan node.

#### Phase 5: Validate live availability

- Query the active gateway/provider through the adapter.
- Confirm that each resolved model is available.
- Confirm that the active OpenCode server accepts the requested configuration.
- Treat an unavailable gateway, model, agent, or required tool as a preflight
  error.
- Treat an adapter that cannot perform the required live validation as a
  preflight error.
- Do not create a session as a live availability probe.

#### Phase 6: Validate transitions

- Order the executable Plan nodes using the runtime's existing deterministic
  order.
- Compare adjacent resolved profiles.
- Ask the adapter to classify each transition.
- Record safe model-only transitions as warnings.
- Record unsupported transitions as errors.
- Do not create a session when an unsupported transition exists in the static
  agent path.

#### Phase 7: Create the session

Create the OpenCode session only after all required preflight phases pass.

### Preflight result

Preflight returns either:

```ts
interface AgentPreflightSuccess {
  readonly status: "ready";
  readonly plan: Plan;
  readonly resolvedNodes: ReadonlyMap<PlanNodeId, ResolvedAgentProfile>;
  readonly safeTransitions: readonly SafeAgentTransition[];
}
```

or a typed aggregate failure:

```ts
interface AgentPreflightFailure {
  readonly status: "failed";
  readonly issues: readonly AgentPreflightIssue[];
}
```

A failure contains codes, source references, and structured details. Runtime
behavior must not depend on issue message text.

## 8. OpenCode Adapter Contract

The private adapter resolves a Seqlane agent profile to OpenCode behavior.

The adapter must expose these private operations:

- parse and validate the exact OpenCode configuration;
- resolve an OpenCode agent and its effective model/tool setup;
- validate static provider, model, gateway, agent, and tool references;
- perform live availability validation without creating a session;
- classify a transition between two resolved setups;
- apply the initial configuration at session setup;
- apply a session-safe model change per prompt; and
- report an unsupported transition without starting a replacement session.

OpenCode prompt requests can carry adapter-supported model values.
They cannot carry an arbitrary Seqlane tool overlay in the first iteration.
The OpenCode agent remains the source of truth for runtime-native configuration.

If an agent profile maps to an OpenCode agent, the adapter must not send a
conflicting independent model value unless the adapter defines and tests the
precedence. The default rule is to send the agent reference and let OpenCode
resolve the agent's model and policies.

## 9. Session Transition Rules

The runtime keeps the previous resolved agent profile and the current
invocation's resolved agent profile in a private session state.

Classify transitions as follows:

| Transition | First-iteration behavior |
| --- | --- |
| Same effective profile | Reuse session; no warning |
| Model-only change supported per prompt | Reuse session; emit warning |
| Agent-key change with model-only effective difference | Reuse session; emit warning |
| Tool policy change | Fail unless adapter proves prompt-level safety |
| Gateway/provider change | Fail |
| Session configuration change | Fail |
| Unknown or unresolved profile | Preflight error |

The adapter must compare effective behavior, not only profile key names. Two
different keys can resolve to the same effective setup. One key can resolve to
different setups in different runtime configurations.

The first invocation establishes the session profile. The runtime does not
emit a transition warning for this initial selection.

For a repeat body, classify the first body invocation against the outer
profile. Classify later iterations against the previous iteration profile.
The profile remains the same for each iteration unless a future dynamic
profile feature changes this rule.

## 10. Warning Event Contract

Add a canonical warning event to `@seqlane/protocol`.

Conceptual shape:

```ts
interface SeqlaneWarning {
  readonly code: "agent-model-changed";
  readonly message: string;
  readonly details: {
    readonly previousAgentKey?: string;
    readonly nextAgentKey?: string;
    readonly changedFields: readonly ("model")[];
  };
}

interface RunWarningEvent {
  readonly type: "run.warning";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly planNodeId?: PlanNodeId;
  readonly invocationId?: InvocationId;
  readonly warning: SeqlaneWarning;
}
```

The final event type can use the package's existing metadata and event naming
conventions. The event must remain JSON-safe and consumer-agnostic.

### Warning rules

- Safe model-only profile changes emit one warning immediately before the
  affected invocation starts. Preflight records the transition but does not
  emit the event early.
- The warning includes stable `code` and structured `details`.
- The warning does not include credentials, prompts, raw OpenCode config, or
  provider response data.
- Warnings do not change the Run exit status in the first iteration.
- The CLI renders the warning with the affected task and transition.
- Studio stores and renders the warning from the canonical event stream.
- Recording and replay preserve the warning event.
- An invalid or unsupported transition emits a failure event, not a warning.

### Event ordering

For a transition on a task invocation, emit events in this order:

```text
invocation.created
run.warning
invocation.started
invocation.progress
...
```

The runtime emits the warning immediately before the affected invocation's
`invocation.started` event. It must identify the Plan node and invocation.

## 11. Error Contract

Use a typed runtime configuration error with an error code and structured
issues. Preserve the original cause for adapter and gateway failures.

Minimum issue codes:

- `invalid-runtime-config`
- `invalid-agent-key`
- `missing-runtime-default`
- `missing-agent-profile`
- `conflicting-task-definition`
- `missing-opencode-agent`
- `missing-opencode-model`
- `missing-opencode-tool`
- `missing-opencode-gateway`
- `live-model-unavailable`
- `live-gateway-unavailable`
- `live-validation-unsupported`
- `invalid-opencode-session-config`
- `unsupported-session-transition`

Each issue includes:

```ts
interface AgentPreflightIssue {
  readonly code: string;
  readonly message: string;
  readonly agentKey?: string;
  readonly workflowId?: string;
  readonly taskId?: string;
  readonly planNodeId?: PlanNodeId;
  readonly details?: JsonValue;
}
```

The runtime aggregates independent issues. It does not stop at the first
missing agent. It still stops before session creation.

## 12. Runner and Package Boundaries

### `seqlane-core`

- owns the optional `agent` string fields;
- validates key shape only;
- retains executor-neutral definitions and Plan serialization;
- does not import runtime configuration or OpenCode types.

### `seqlane-runtime`

- owns runtime configuration loading;
- resolves agent keys;
- performs preflight;
- tracks effective agent transitions; and
- coordinates the private adapter.

### `seqlane-opencode`

- owns the pinned OpenCode schema and SDK types;
- validates OpenCode configuration;
- resolves agents, models, tools, and gateways;
- performs live availability checks; and
- classifies and applies prompt-level transitions.

### `seqlane-events`

- owns the serialized warning event;
- validates and encodes warning events; and
- preserves warnings for recording and replay.

### CLI and Studio

- CLI renders warnings and includes them in JSON/NDJSON output where those
  renderers already expose execution events;
- Studio consumes the canonical warning event and does not reconstruct it from
  logs;
- neither consumer makes agent decisions from warning message text.

### Runner IPC

The public run command remains a workflow reference, input, and generic runtime
reference. It does not carry OpenCode configuration, credentials, resolved
profiles, or model/tool objects.

Conceptually, the private runtime reference may carry the selected file path:

```ts
interface RuntimeProfileReference {
  readonly id: string;
  readonly configPath?: string;
}
```

`configPath` is an absolute path selected by the CLI. It contains no config
contents or secrets.

The CLI selects or discovers the config path and includes only that path in
the private runtime reference sent over IPC. The runner loads and validates
the configuration inside the runner process. Configuration contents and
secrets never enter the command payload.

## 13. Security and Data Handling

- Treat runtime configuration, workflow definitions, and OpenCode responses as
  untrusted input at their boundaries.
- Validate JSON and schema data before use.
- Do not use unchecked parser results as typed configuration.
- Do not include credentials in profile records that cross a public boundary.
- Do not emit gateway URLs with embedded credentials in warnings or errors.
- Redact secret-bearing configuration fields before diagnostics.
- An unresolved OpenCode interaction remains a task failure under the
  autonomous execution rules.
- An agent profile must not broaden authority during a task transition without an
  explicit future policy decision.
- Do not log complete OpenCode configuration blocks by default.

## 14. Compatibility

Existing workflows without `agent` fields continue to work when the runtime
provides a valid default agent. Their Plans remain byte compatible because
agent metadata stays outside the Plan.

Existing hand-authored Plans cannot select task-specific profiles in the first
iteration. They use the runtime default. Adding profile metadata to a Plan is
out of scope.

Existing runtime profiles that do not provide the new agent registry must fail
with a typed configuration error when a workflow needs an agent. A compatibility
runtime can provide one default agent for migrated workflows.

Warnings add a canonical event variant. Existing event consumers must accept
unknown future variants according to the event package's versioning rules, or
the package must provide the normal compatibility path for adding an event.

## 15. Test Requirements

### Core contract tests

- workflow and task agent keys accept valid non-empty keys;
- empty, whitespace-only, and surrounding-whitespace keys fail;
- omitted task keys inherit workflow keys conceptually;
- agent keys do not appear in serialized Plans;
- direct model IDs are not introduced into core contracts;
- conflicting task definitions with one task ID fail;
- repeated invocations use one task definition and one key.

### Runtime resolution tests

- task key overrides workflow key;
- workflow key overrides runtime default;
- runtime default resolves when both authoring keys are absent;
- missing runtime default fails before session creation;
- missing profile errors include all source references;
- duplicate agent keys or conflicting entries fail configuration parsing;
- unused task definitions do not create profile requirements;
- evaluator tasks resolve profiles;
- mechanical validators do not resolve profiles;
- repeat-body tasks resolve profiles;
- two runtime configurations can resolve one key differently.

### OpenCode configuration tests

- the exact pinned OpenCode configuration schema accepts valid configuration;
- malformed OpenCode configuration fails before session creation;
- missing agent/model/tool/gateway references fail preflight;
- credentials do not appear in errors, events, or logs;
- the adapter does not ignore unsupported session configuration;
- live validation checks the gateway and model without creating a session;
- live validation failure prevents session creation.

### Transition tests

- the first profile selection emits no transition warning;
- an identical effective profile emits no warning;
- a safe model-only change reuses the current session and emits one warning;
- the warning contains stable code and structured transition details;
- a tool policy change fails before the affected task runs;
- a gateway change fails before the affected task runs;
- the adapter selected for the Run is never changed by an agent transition;
- no unsupported transition starts a replacement session;
- repeat iterations apply the transition rules consistently.

### Event and consumer tests

- warning events encode and decode through the canonical event package;
- malformed warning events are rejected;
- warning event ordering is stable;
- CLI renders warning code and affected task information;
- Studio projection retains warnings from canonical events;
- recording and replay preserve warnings;
- consumers do not depend on warning message text.

### Boundary tests

- core exports contain no OpenCode or runtime configuration types;
- Plans contain no agent profile data;
- runner commands contain no OpenCode configuration or credentials;
- OpenCode configuration remains private to runtime/adapter packages;
- built-in workflow source remains free of provider, model, tool, gateway, and
  permission configuration.

## 16. Delivery Slices

Implement the work in this order:

1. Add core agent-key contracts, validation, and Plan-boundary tests.
2. Add private runtime configuration and profile resolution.
3. Add static and live preflight with aggregate typed errors.
4. Add OpenCode configuration validation and adapter profile resolution.
5. Add single-session transition classification and runtime guards.
6. Add canonical warning events and consumer projections.
7. Add compatibility, security, fixture, and boundary coverage.

Each slice must keep existing workflows executable or provide the required
runtime default. Do not start implementation of the next slice while the
previous slice has failing acceptance tests.

## 17. Open Questions and Deferred Decisions

- The exact environment-loading path and precedence around Cosmiconfig are not
  decided by this specification; the supported file names and formats are
  fixed above.
- The exact OpenCode live availability endpoint depends on the pinned SDK and
  server version.
- The final warning event field names must follow the current canonical event
  package conventions.
- The adapter capability contract for prompt-level model changes needs a
  concrete OpenCode proof test.
- Multi-session execution, explicit session boundaries, and context handoff
  require a new ADR.
- Direct model references require a later decision about portability and
  workflow/runtime ownership.

## 18. Acceptance Summary

The MVP is complete when:

- authors can select only logical agent profiles on workflows and tasks;
- runtime configuration resolves every used key;
- static and live validation finish before session creation;
- OpenCode receives its exact validated configuration through the private
  adapter lifecycle;
- model-only same-session transitions emit canonical warnings;
- unsupported transitions fail without creating a replacement session;
- CLI and Studio consume the same warning events; and
- existing workflows remain compatible through a valid runtime default.

## Traceability

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
