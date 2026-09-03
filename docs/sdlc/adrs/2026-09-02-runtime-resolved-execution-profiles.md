---
id: adr.runtime-resolved-execution-profiles
title: Resolve Workflow Agent Profiles at Runtime
status: proposed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Resolve Workflow Agent Profiles at Runtime

## Context

Seqlane workflows need reusable agent choices. A workflow may need a
different agent setup from another workflow, and a task may need to override
its workflow's setup. An agent setup can include a model, tools, permissions,
gateway, and behavior specific to the already-selected adapter.

Concrete provider and OpenCode configuration must remain outside workflow source
and serialized Plans. The same workflow must be executable with different
runtime configurations, including configurations that use different gateways.
Each run already has one adapter selected by the existing CLI/runtime
mechanism. This ADR does not add or change any CLI command, flag, or runtime
selection interface. All workflows and tasks in a run use that same adapter;
agent configuration must not select or change it.

Agent changes also have observable effects. A model can sometimes change
for one prompt, while changes to tools, permissions, agents, or gateways may
not be safe within the existing OpenCode session. Starting a replacement
session without an explicit decision would create hidden context and behavior
changes.

## Options Considered

### Put concrete model and tool configuration in workflows

This makes a workflow self-contained, but couples workflow source and Plans to
providers, gateways, tools, permissions, and executor behavior. It prevents a
runtime from adapting the same workflow to its available models. Rejected.

### Allow direct model IDs and separate task-level tool/permission overlays

This keeps model selection flexible, but creates two policy systems and makes
the effective agent setup difficult to validate. It also makes a task's
authority depend on merge and precedence rules. Deferred.

### Reference runtime-owned agent profiles

Workflows and tasks contain only an opaque profile key. The runtime resolves
the key to a complete agent setup and validates it against the active
adapter configuration. This preserves workflow portability and makes a
profile a reusable, tested combination of model, tools, permissions, and
gateway. Chosen.

## Decision

Seqlane will support an opaque `agent` key on workflow and task definitions. A
task-level key overrides the workflow-level key. The runtime default applies
when neither defines a key.

```text
task agent profile
  → workflow agent profile
  → runtime default
```

Agent keys are logical runtime references. They are not provider
model IDs, executor selectors, OpenCode agent names, gateway URLs, or
credentials. Direct model IDs in workflow and task source are out of scope for
the first iteration.

The runtime configuration owns the agent registry. An agent resolves to a
complete configuration for the already-selected adapter. Profiles do not have
task-level overlays in the first iteration.

The CLI selects the runtime configuration. It accepts an optional
`--config <path>` flag. Without the flag, it discovers only
`seqlane.config.json` and `seqlane.config.ts` with Cosmiconfig's
asynchronous API. The CLI passes the resolved path, not configuration
contents, to the runner over IPC. The runner loads and validates the file
before execution. This ADR does not add support for YAML, TOML, RC files, or
additional configuration formats. A TypeScript configuration is trusted
executable code and must export the configuration object as its default
export.

The OpenCode adapter will receive an exact, version-pinned OpenCode
configuration block. Seqlane will not reproduce or flatten that schema in
core. The adapter owns applying the block at the earliest lifecycle point
supported by OpenCode and translating the resolved profile to OpenCode
requests.

## Validation

The runtime will validate agent configuration before creating an OpenCode
session:

1. Load and validate the runtime configuration selected by the CLI and its
   OpenCode configuration block.
2. Resolve every workflow and task agent key, including keys used by
   repeat bodies and validation tasks.
3. Validate that each resolved profile is valid for the already-selected
   adapter and has valid model, gateway, tool, and permission configuration.
4. Perform live gateway/model availability checks through the adapter.
5. Aggregate configuration failures and report them before task execution.

Core may validate only the shape of an agent key. The runner owns loading and
validation; runtime configuration is the authority for whether the key and its
resolved dependencies exist.

## Session Transitions

The first iteration uses one OpenCode session per Seqlane Run. It will never
start a replacement session implicitly.

A transition between two resolved profiles is allowed in the existing session
only when the adapter confirms that the changed properties are safe to apply
per prompt. A model-only change supported by OpenCode is a warning-producing
transition. Changes to tools, permissions, OpenCode agents, gateways, or other
session-scoped properties fail the run when they cannot be applied safely in
the existing session.

The adapter cannot change during a run. Selecting a different adapter remains
the responsibility of the existing run invocation mechanism and is outside
this ADR.

Multi-session execution, explicit session boundaries, and context handoff are
deferred to a future ADR.

## Warnings and Events

Safe agent transitions will emit structured warning events with one stable
code and machine-readable fields. A warning will identify the affected
  workflow/task or invocation and the previous and next agent keys when
available.

The CLI will render these warnings. Studio and future consumers will receive
the same canonical events. Consumers must not parse warning message text to
determine behavior.

Unsupported or invalid transitions are errors, not warnings.

## Consequences

### Positive

- Workflows remain independent of concrete providers and gateways.
- Runtime environments can resolve the same agent key differently.
- Model, tool, and permission combinations become reusable configuration.
- Configuration errors are found before a session or task starts.
- CLI and Studio receive the same transition warnings.
- Session replacement cannot happen as an unnoticed adapter side effect.

### Negative

- A workflow cannot be fully understood without its runtime profile registry.
- Runtime startup must validate both configuration and live adapter state.
- Agent changes that require new sessions cannot be used in the first
  iteration.
- Agent definitions may need to be duplicated for intentionally different
  tool or permission combinations.
- OpenCode schema compatibility becomes an adapter/version-management concern.

## Follow-up Constraints

- Keep agent profile contents out of `seqlane-core` and serialized Plans.
- Keep OpenCode SDK types, configuration, credentials, and gateway details in
  private runtime/adapter packages.
- Use aggregate, typed validation errors for missing or invalid agent
  references.
- Emit warnings through the canonical consumer-agnostic event contract.
- Do not add implicit session recreation, context summarization, or context
  handoff under this ADR.
- Keep direct model IDs and model keys out of workflow and task source in this
  iteration. Revisit them only through a later portability decision.
- adr.executor-neutral-workflow-authoring remains intact: `agent` is a logical Seqlane runtime key, not an
  executor selector or an OpenCode agent name. OpenCode configuration remains
  private to the runtime adapter.

## Revisit Conditions

Revisit this decision when Seqlane needs direct model selection in workflow
source, task-level policy overlays, multiple sessions per run, explicit
context handoff, or executor-neutral capability requirements that cannot be
represented by runtime-owned agent profiles.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
