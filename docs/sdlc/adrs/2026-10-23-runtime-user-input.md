---
id: adr.runtime-user-input
title: Support Structured User Input During Agent Execution
status: accepted
owners:
  - core
created: 2026-10-23
updated: 2026-10-24
upstream:
  - prd.seqlane-runtime
  - adr.autonomous-non-interactive-execution
supersedes:
  - adr.autonomous-non-interactive-execution
---

# Support Structured User Input During Agent Execution

## Context

A skill can discover missing information during an agent invocation. The
workflow author cannot always predict the questions or their choices.
Today, Seqlane treats unresolved interaction as an invocation failure.
The runner accepts only start and cancellation commands.

We need an optional path that returns a user's answer to the same agent
invocation. Autonomous workflows must retain their current default behavior.

## Decision

### decision-runtime-user-input

Introduce a run policy for structured user input. The default disables input.
An operator explicitly enables input for a supported adapter and connected
consumer. The first consumer is the local terminal CLI.

An input tool accepts questions that the agent creates during execution.
The runtime owns request identity, deadlines, validation, and response routing.
The adapter translates requests and answers at the native agent boundary.
Neither workflow definitions nor Plans contain the questions or native tool
types. Task input and output contracts remain unchanged.

The first contract supports text and single-choice questions, including a
free-text alternative. It does not accept arbitrary JSON Schema from agents.
The fixed question format supplies enough information for runtime answer
validation and consumer presentation.

An invocation waits without completing or restarting. Its agent process,
session lock, and workspace leases remain live. Independent work continues
only when existing admission rules permit it.

Permission approval remains a separate concern. A user answer cannot grant
execution authority or override the adapter's permission policy.

### decision-structured-tool

The adapter must expose a native question operation or an equivalent callable
tool. Run instructions tell the agent when to use that tool. Prompt text alone
does not establish support. Seqlane never detects questions by parsing prose.

The logical tool name is `ask_user`. An adapter can use another native name
when its injected instructions identify that name. Unsupported adapters reject
interactive admission before agent execution.

## Alternatives considered

| Option | Benefit | Cost | Outcome |
| --- | --- | --- | --- |
| Fail every question | Preserves the existing autonomous contract | Cannot complete workflows that discover missing information | Retain as default policy |
| Declare human steps in the workflow | Static types and visible graph nodes | Cannot represent unknown questions inside an agent invocation | Separate future feature |
| Parse agent prose | Requires no native tool integration | Cannot reliably distinguish a question, quotation, or completed answer | Reject |
| Structured runtime tool | Dynamic questions with validated responses | Requires adapter, protocol, and consumer changes | Select |
| Persist and resume the whole run | Supports disconnected users and restarts | Requires recoverable agent continuations and durable execution state | Defer |

## Consequences

The runner becomes bidirectional for enabled runs. Consumers must track
pending requests separately from progress text. An answer does not complete
the task or replace its validated output.

Waiting retains processes and leases. Deadlines and cancellation bound that
cost. Disconnects terminate the live interaction. Reopening a UI does not
recover the run.

The contracts remain independent of the runtime engine and agent SDK.
Canonical Seqlane events describe interaction state. Display activity and
native telemetry cannot become the interaction control channel.

## Migration

This decision supersedes the universal input prohibition in
`adr.autonomous-non-interactive-execution`. The disabled policy retains the
existing failure behavior. The operator must explicitly enable user input.

The active product requirement and specifications define the implementation
contract. Acceptance does not establish implementation delivery.

## Revisit conditions

Revisit this decision when a consumer needs detached execution, process
restart recovery, arbitrary forms, or permission approval. Each requires
additional semantics beyond a live question round trip.

## Delivery state

Accepted for implementation. Native adapter support and target-branch delivery
require the evidence recorded by the linked delivery task.

## Traceability

- [prd.seqlane-runtime: runtime user input](../prd/2026-10-21-seqlane-runtime.md#requirement-runtime-user-input)
- [adr.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- [spec.runtime-user-input](../specs/2026-10-23-runtime-user-input.md)
- [task.runtime-user-input-round-trip](../tasks/2026-10-23-runtime-user-input-round-trip.md)
