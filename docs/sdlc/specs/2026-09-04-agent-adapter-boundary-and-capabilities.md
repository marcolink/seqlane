---
id: spec.agent-adapter-boundary-and-capabilities
title: Agent Adapter Boundary and Capability Model
status: active
owners:
  - core
created: 2026-09-04
updated: 2026-09-16
upstream:
  - adr.executor-neutral-workflow-authoring
  - adr.opencode-executor-integration
  - adr.session-checkpoint-reuse-and-branching
supersedes:
  - spec.opencode-executor-integration
---

# Agent Adapter Boundary and Capability Model

## Standalone CLI integration

[spec.standalone-cli-runs](./2026-09-16-standalone-cli-runs.md#requirement-adapter-lifecycle)
adds a no-config startup contract for `run --adapter <id>`. The command resolves
native configuration and manages required service startup. Private adapter
connection configuration remains valid internally; users need not supply it.

OpenCode task execution still uses the SDK. Starting its required service does
not replace SDK task execution with a CLI prompt transport. Native adapter
permissions and authentication remain authoritative. This integration is
pending under the standalone delivery task.

## Summary

Seqlane supports agent runtimes through one private adapter contract. The
current implementations are a generic ACP adapter and an OpenCode SDK adapter.
The planned Codex app-server adapter uses the same contract.

The ACP adapter contains no OpenCode types, commands, defaults, or session
assumptions. The OpenCode adapter uses only the supported OpenCode SDK.
The Codex adapter uses the app-server protocol and keeps Codex types private.

This specification supersedes the interim ACP/OpenCode design from
`task.mastra-agent-acp`. That completed task remains a historical delivery
record, but its adapter design is no longer authoritative.

## Goals

- Define one private, executor-neutral adapter contract for agent execution.
- Implement ACP without a built-in OpenCode provider or command.
- Keep OpenCode execution, sessions, and capabilities in an SDK-only adapter.
- Select and validate one adapter before session creation.
- Represent session, checkpoint, and fork support as explicit capabilities.
- Fail preflight when the selected adapter lacks a required capability.

## Non-goals

- Expose adapter selection in workflow source or serialized Plans.
- Define a public plugin system for third-party adapters.
- Emulate checkpoints or forks with prompts, summaries, or copied transcripts.
- Combine ACP and OpenCode state in one logical session.
- Add automatic fallback between adapters.
- Change the public task, Plan, event, or output contracts.

## Terminology

- **Agent adapter:** A private runtime implementation for agent tasks.
- **Adapter selection:** One validated adapter identity and its configuration.
- **Adapter session:** One adapter-owned handle for task execution.
- **Capability:** An operation that an adapter proves and exposes to preflight.
- **Checkpoint:** An opaque adapter value that identifies an exact session state.
- **Exact fork:** A new session that starts from one exact checkpoint.

## Requirements

### requirement-agent-adapter-boundary

The runtime must depend on a Seqlane-owned agent adapter contract. The contract
must not contain ACP, OpenCode, Mastra, or provider SDK types.

The adapter receives validated Seqlane task input, output schema, model
selection, cancellation signal, and observation callbacks. It returns a
validated task result and normalized metrics.

### requirement-composition-owned-adapters

The runtime receives a generic adapter binding or factory from its caller.
It must not import concrete adapter packages, construct their implementations,
or branch on their error classes. Adapter-specific startup and configuration
belong to the adapter package and the application composition root.

CLI and server composition select the concrete implementation, validate its
configuration, and supply it to the runtime. Runtime code manages execution
through generic lifecycle, capability, session, and model contracts.

New standalone lifecycle code follows this boundary. Removing the existing
runtime registry's concrete imports is deferred to
[task.decouple-runtime-adapter-composition](../tasks/2026-09-16-decouple-runtime-adapter-composition.md).
This requirement refines implementation ownership; it does not introduce a
public plugin API or claim that the existing runtime is already decoupled.

### requirement-generic-acp-adapter

The generic ACP adapter must accept validated ACP launch or connection
configuration. It must not hard-code `opencode`, `opencode acp`, an OpenCode
model format, or OpenCode session behavior.

The adapter must isolate ACP library types and stream payloads. It must map
supported activity, cancellation, interaction, output, and error behavior to
the Seqlane-owned contract.

### requirement-opencode-sdk-only

The OpenCode adapter must use supported exports from the pinned OpenCode SDK.
It must not route work through ACP, a CLI subprocess, or a Mastra ACP agent.

The adapter must use the selected OpenCode endpoint and workspace
configuration. It must preserve the OpenCode repository harness and native
session behavior.

### requirement-codex-app-server-boundary

The planned Codex adapter must implement this same private adapter contract.
It must keep app-server messages, thread IDs, and turn IDs inside its package.
Its protocol, lifecycle, and first-delivery scope are defined in
[spec.codex-app-server-adapter](./2026-09-12-codex-app-server-adapter.md).

### requirement-explicit-adapter-selection

Application composition must select exactly one adapter before model preflight
or adapter session creation. The selection uses a canonical configuration
schema and a registered adapter identity.

Composition must reject missing, unknown, mixed, or invalid adapter
configuration. It must not infer ACP from an OpenCode endpoint or infer
OpenCode from an ACP command. Standalone demand-time selection follows the
standalone CLI contract.

Adapter selection remains private runtime configuration. Workflow definitions,
Plans, runner events, and task results remain executor-neutral.

### requirement-capability-preflight

Each adapter must declare capabilities before task execution. The runtime must
compare the workflow session policy and model requirements with this
declaration.

The runtime must reject an unsupported requirement before workspace mutation
or model work. An adapter must not advertise a capability that its active
configuration cannot perform.

### requirement-session-checkpoint-fork

Session reuse, checkpoint capture, and exact fork are separate capabilities.
Support for one capability does not imply support for another capability.

A checkpoint stays private to its adapter instance and run. The runtime must
reject checkpoints from another adapter, run, or incompatible configuration.

An exact fork must use the selected adapter's native fork operation. If that
operation does not exist, the adapter must declare no fork capability.

### requirement-no-cross-adapter-fallback

One logical session must use one adapter. Execution, checkpoint capture, fork,
cancellation, model selection, and session UI must use that same adapter.

The runtime must not execute through ACP and capture a checkpoint through the
OpenCode SDK. It must not switch adapters after a capability failure.

### requirement-autonomous-interactions

Each adapter must reject unresolved permission and user-input requests through
the shared non-interactive failure contract. No adapter can approve an
interaction on behalf of the user.

### requirement-private-observability

Adapters must emit normalized metrics, diagnostics, activity, and session UI
data when they support these values. Raw protocol events remain private.

Logs and errors must not include secrets from adapter configuration. Public
errors must preserve a private cause without exposing SDK objects.

## Detailed design and contracts

### Package boundary

```text
Application composition --> Seqlane runtime
      |                         |
      | supplies                v
      +----------------> generic adapter contract
      |
      +--> ACP implementation
      +--> OpenCode adapter --> OpenCode SDK --> OpenCode server
      +--> Codex adapter ----> Codex app-server
```

The generic ACP implementation belongs in a private ACP package. The OpenCode
package must not export or depend on the ACP adapter.

Mastra can own workflow execution around both adapters. Mastra does not select
the adapter and does not change the adapter's session semantics.

### Adapter lifecycle

An adapter registration contains a stable private identity, a configuration
schema, and a capability resolver. The registration creates adapter sessions
only after configuration and capability preflight succeeds.

An adapter session owns task execution and cancellation. Optional session
operations expose checkpoint capture, exact fork, and session UI.

The runtime treats absent optional operations as unsupported capabilities. It
does not add compatibility behavior around the session handle.

### Capability model

| Capability | Meaning | Runtime rule |
| --- | --- | --- |
| `execute` | Execute one validated agent task. | Required for every agent adapter. |
| `model-selection` | Apply a validated model and reasoning selection. | Reject explicit selection when absent. |
| `structured-output` | Return output for local schema validation. | Required for typed task output. |
| `session-reuse` | Execute ordered tasks in one adapter session. | Required for shared sessions. |
| `checkpoint` | Capture one exact, opaque session state. | Required before a checkpoint is published. |
| `fork` | Create a new session from one exact checkpoint. | Required for branch sessions. |
| `activity` | Report normalized tool and skill activity. | Optional and never inferred from text. |
| `session-ui` | Report an adapter-owned session URL. | Optional and bound to the selected adapter. |

Cancellation and non-interactive failure handling are mandatory behaviors.
They are not optional capability flags.

### Initial capability mapping

The ACP adapter can declare only capabilities that the configured ACP
implementation proves through integration tests. It must declare no checkpoint
or fork support until those exact operations are available.

The OpenCode SDK adapter can declare native session reuse, terminal-message
checkpoints, and exact session forks after compatibility preflight. It can also
declare native model selection, activity, and session UI support.

The planned Codex adapter can declare only capabilities proved against its
pinned app-server version. Its first delivery does not declare session UI.

This mapping is configuration-sensitive. A version or connection that lacks a
required operation must fail preflight and must not downgrade silently.

### Configuration model

The canonical runtime configuration uses a discriminated adapter identity.
Each identity selects one adapter-owned configuration schema.

ACP configuration identifies the ACP implementation and its launch or
connection parameters. OpenCode configuration identifies the endpoint,
workspace, and supported SDK options.
Codex configuration identifies its local executable; the runtime supplies the
workspace. Codex does not use OpenCode or ACP configuration fields.

Application composition validates configuration before it starts a process or contacts a
server. It redacts environment values, credentials, and tokens from errors and
events.

## Failure and edge cases

- An unknown adapter identity fails configuration validation.
- Configuration for more than one adapter fails validation.
- An unavailable ACP command fails without an OpenCode fallback.
- An unavailable OpenCode endpoint fails without an ACP fallback.
- A branch request fails before execution when `fork` is not available.
- A checkpoint from a different adapter or run fails validation.
- An adapter capability change after preflight fails the session.
- Cancellation affects only the selected adapter session.
- An unresolved interaction fails without a response or approval call.

## Migration

PR 19 can retain its interim design until this follow-up stack replaces it.
The debt is temporary and does not become a contract for later Mastra work.

The PR 19 review identified four deferred architecture findings. This
specification is the single owner of those findings.

| Deferred finding | Owning task |
| --- | --- |
| ACP ignores the configured runtime endpoint and configuration. | `task.protocol-agnostic-acp-adapter` and `task.explicit-runtime-adapter-selection` |
| ACP execution and OpenCode checkpoints use different sessions. | `task.session-checkpoint-fork-capabilities` |
| The native OpenCode executor remains a duplicate exported path. | `task.opencode-sdk-only-adapter` |
| ACP tests replace the real Mastra ACP boundary with a fake agent. | `task.agent-adapter-integration-cleanup` |

Later Mastra stack tasks must not copy these findings into their scope. They
can depend on this specification without redesigning the adapter boundary.

Migration completes when no production session combines ACP execution with
OpenCode SDK state. It also requires the removal of interim exports and
configuration inference.

## Verification

- Run the focused contract tests for the generic adapter boundary.
- Run real ACP integration tests with a controlled ACP process.
- Run OpenCode SDK contract tests with a controlled server.
- Prove explicit selection and malformed configuration failures.
- Prove shared, isolated, checkpoint, and branch admission by capability.
- Search public declarations, Plans, and events for adapter-specific types.
- Run the repository test, type, lint, build, format, and documentation gates.

## Acceptance criteria

- The generic ACP adapter contains no OpenCode assumptions.
- The OpenCode adapter uses only the OpenCode SDK for agent execution.
- Runtime configuration selects exactly one adapter before preflight.
- Unsupported session requirements fail before execution.
- Execution and session lifecycle use the same selected adapter.
- ACP and OpenCode integration tests exercise their real private boundaries.
- No ACP, OpenCode, or Mastra type enters a public Seqlane contract.
- The interim PR 19 exports and mixed-session behavior no longer exist.

## Delivery tasks

1. [task.protocol-agnostic-acp-adapter](../tasks/2026-09-04-protocol-agnostic-acp-adapter.md)
2. [task.opencode-sdk-only-adapter](../tasks/2026-09-04-opencode-sdk-only-adapter.md)
3. [task.explicit-runtime-adapter-selection](../tasks/2026-09-04-explicit-runtime-adapter-selection.md)
4. [task.session-checkpoint-fork-capabilities](../tasks/2026-09-04-session-checkpoint-fork-capabilities.md)
5. [task.agent-adapter-integration-cleanup](../tasks/2026-09-04-agent-adapter-integration-cleanup.md)

## Traceability

- [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.opencode-executor-integration](../adrs/2026-09-02-opencode-executor-integration.md)
- [adr.session-checkpoint-reuse-and-branching](../adrs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.mastra-runtime-and-operational-integration](./2026-09-03-mastra-runtime-and-operational-integration.md)
- [spec.codex-app-server-adapter](./2026-09-12-codex-app-server-adapter.md)
- Supersedes [spec.opencode-executor-integration](./2026-09-02-opencode-executor-integration.md).
- Replaces the interim design from [task.mastra-agent-acp](../tasks/2026-09-03-mastra-agent-acp.md).
