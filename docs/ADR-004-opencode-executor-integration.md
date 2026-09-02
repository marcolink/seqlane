# ADR-004 — Integrate OpenCode Through a Seqlane-Owned Executor Boundary

**Status:** Implemented; workflow-authoring portion superseded by ADR-008
**Scope:** Initial coding-agent executor  
**Related:** RFC 1, Seqlane MVP

## Context

Seqlane needs a repository-aware coding agent capable of inspecting and modifying code, using repository instructions and skills, running tools and shell commands, and returning structured results.

OpenCode already provides this coding-agent environment and repository harness.

Seqlane should orchestrate OpenCode without becoming a second coding harness or coupling Seqlane workflow definitions to OpenCode SDK objects.

The MVP intentionally limits infrastructure scope by requiring an already-running OpenCode server.

## Decision

OpenCode will be the initial Seqlane coding executor behind the generic Seqlane `Executor` abstraction.

```text
Seqlane invocation
       ↓
Seqlane OpenCode executor
       ↓
OpenCode typed SDK/client
       ↓
OpenCode server
       ↓
repository agent environment
```

Seqlane workflow authors do not interact with:

- raw OpenCode session IDs;
- message IDs;
- OpenCode message/part types;
- provider/model identifiers;
- OpenCode SDK client objects;
- raw OpenCode errors or events.

Those remain adapter/runtime concerns.

## MVP Runtime Mode

The MVP connects to an **externally running OpenCode server**.

Seqlane does not start or stop OpenCode in the MVP.

A Seqlane Run creates one new OpenCode session on that server.

All MVP OpenCode invocations execute sequentially through the same session.

The externally supplied runtime remains externally owned.

## Long-Term Runtime Modes

The architecture reserves:

- Seqlane-managed OpenCode runtime;
- external OpenCode runtime;
- existing-session attachment.

Managed runtime is intended to become the normal self-contained execution mode after MVP.

External modes remain supported for development, debugging, and deliberate continuation of existing agent context.

## Repository Harness

OpenCode remains authoritative for repository-specific agent behavior.

Seqlane does not parse and reconstruct:

- `AGENTS.md`;
- OpenCode configuration;
- repository skills;
- agents;
- tools;
- plugins;
- MCP;
- repository instructions.

The semantic model is:

```text
Repository OpenCode Harness
            +
Seqlane additions
            +
Task objective
            ↓
         OpenCode
```

Seqlane additions are additive by default.

Native OpenCode capabilities should remain native rather than being flattened into prompt text.

## Structured Output

A Seqlane OpenCode task with an output schema requests structured output from OpenCode.

The result crosses a Seqlane validation boundary:

```text
OpenCode structured result
          ↓
Seqlane schema validation
          ↓
typed Seqlane output
```

OpenCode-side validation does not replace Seqlane validation.

Only the validated task result enters Seqlane semantic dataflow.

Conversation messages, tool calls, shell output, and subagent activity remain execution context and observability data.

## Sessions and Checkpoints

The full design distinguishes shared, isolated, and forked Seqlane session policies.

Shared-session invocations are serialized by Seqlane to preserve deterministic message boundaries.

Every successful OpenCode invocation should eventually retain the exact session/message checkpoint needed for deterministic forks and provenance.

Checkpoint/fork functionality is post-MVP.

## Cancellation and Permissions

Seqlane cancellation must propagate into active OpenCode execution.

Seqlane must never implicitly broaden OpenCode authority.

The OpenCode environment must be configured so V1 workflows can execute autonomously. An unresolved permission requirement fails rather than causing an interactive Seqlane prompt.

## Consequences

### Positive

- Reuses a capable repository-aware coding harness.
- Preserves existing repository instructions, skills, tools, and configuration.
- Keeps Seqlane focused on orchestration rather than agent-harness implementation.
- Supports conversational continuity across workflow stages.
- Structured outputs provide a clean typed boundary.
- The generic Executor abstraction leaves room for other execution backends.

### Negative

- MVP requires a separately running OpenCode server.
- Seqlane must validate server compatibility.
- Seqlane depends on OpenCode server and SDK behavior.
- Existing-server mode cannot guarantee all future Seqlane Harness Overlay capabilities.
- Shared-session serialization limits concurrency until multiple session policies are implemented.

## Alternatives Considered

### Build a Seqlane-native coding agent

Provides maximal control but duplicates repository harness, model/tool orchestration, and agent execution.

### Invoke OpenCode CLI subprocesses per task

Simple integration but provides a weaker typed/session/event boundary and makes deterministic session continuity harder.

### Use Mastra agents directly

Reduces dependencies but loses the repository-aware OpenCode harness Seqlane wants to preserve.

### Require managed OpenCode from day one

Improves self-contained execution but expands MVP packaging/lifecycle scope before the workflow model is validated.

## Constraints

- OpenCode SDK types do not cross the Seqlane public boundary.
- Seqlane revalidates every declared structured result.
- Repository harness interpretation remains OpenCode-owned.
- Seqlane-created capabilities must not silently shadow existing capabilities.
- Externally owned OpenCode runtimes/sessions are never destroyed by Seqlane.
- MVP execution uses one sequential session per Run.

## Decision Test

Reconsider this ADR if OpenCode cannot provide the required structured task boundary, repository harness behavior cannot be preserved, or managed/external modes cannot share a coherent adapter.
