---
id: spec.codex-app-server-adapter
title: Codex App-Server Adapter
status: draft
owners:
  - core
created: 2026-09-12
updated: 2026-09-12
upstream:
  - spec.agent-adapter-boundary-and-capabilities
  - spec.autonomous-non-interactive-execution
  - spec.session-checkpoint-reuse-and-branching
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Codex App-Server Adapter

## Summary

Seqlane will add a private Codex adapter through the existing `AgentAdapter` contract.
The adapter will use a locally managed `codex app-server` process over stdio.
Workflow source, Plans, runner IPC, and stable results will remain executor-neutral.

The first delivery will use only run-scoped Codex processes and threads.
It will not resume a thread from an earlier Seqlane run or attach to an external app-server.

App-server exposes the thread, turn, and event lifecycle needed by this adapter.
OpenAI recommends the Codex SDK for CI automation, so protocol proof is a delivery gate for this choice.

## Goals

- Execute typed agent tasks with Codex in an isolated or reused thread.
- Create exact branches from completed Codex turns when the pinned protocol proves that operation.
- Preserve Seqlane model, workspace, cancellation, and non-interactive policies.
- Translate Codex output, activity, usage, and errors into Seqlane-owned contracts.

## Non-goals

- Expose Codex names, IDs, messages, permissions, or transport configuration to workflow authors or Plans.
- Attach to Codex Desktop, an external app-server, or an existing user thread.
- Reuse or persist Codex threads across Seqlane runs.
- Add interactive approvals, user-input responses, thread merge, or transcript-based fork emulation.
- Add a public Codex task factory, a second adapter API, or an automatic ACP/SDK fallback.
- Provide a Codex session UI URL without a stable, supported app-server contract.

## Terminology

- **Adapter session:** One private `AgentAdapter` instance bound to one Codex thread.
- **Thread:** A Codex conversation that contains turns.
- **Turn:** One Codex request and its work for one Seqlane task invocation.
- **Checkpoint:** The Codex thread ID and the ID of its completed terminal turn.
- **Host:** The Seqlane process that owns a run's app-server connection and lifecycle.

## Requirements

### requirement-codex-protocol-proof

The implementation must select and pin a Codex CLI version before it claims app-server capabilities.
A controlled probe must prove initialization, model discovery, thread and turn operations, structured output, cancellation, and exact fork behavior.
The probe must also establish event and error shapes used by the adapter.
An unsupported version or operation must fail before the first agent task starts.

### requirement-codex-private-configuration

The private runtime configuration must select `codex` explicitly through the existing discriminated adapter schema.
The first delivery must accept an absolute Codex executable path and an optional `networkAccess` boolean.
The runtime must supply the workspace path. Omitted `networkAccess` means `false`.
It must reject unknown fields and must not infer Codex from a command name or installed binary.
The adapter must use the selected binary, its local authentication, and the repository's Codex instructions.
It must not read or expose authentication material through Seqlane contracts.

### requirement-codex-owned-lifecycle

The host must start the managed app-server process and complete the `initialize` and `initialized` handshake before other requests.
The direct-run host must own one process for its run.
A persistent Seqlane host must own a separate process for each active run.
Each run must own distinct Codex threads.
The host must close each owned connection and process when its run ends or the host shuts down.
An adapter must never stop an app-server process owned by another host.

### requirement-codex-session-semantics

An isolated session must create a new thread with `thread/start`.
A reuse session must send ordered turns to the same thread.
After a successful, fully terminated turn, checkpoint capture must record that turn's ID.
A branch must call `thread/fork` with `lastTurnId` from the checkpoint before it starts child work.
The existing runtime must bind each checkpoint to its run, adapter, and configuration.
The adapter must not reconstruct history from prompts, summaries, or copied messages.

### requirement-codex-model-selection

The adapter must map Seqlane's `openai` model reference to the Codex model ID.
It must reject other providers before execution.
It must use `model/list` to resolve the default model and validate selected models and reasoning effort.
A reused thread must keep its pinned effective selection.
A branch can select another supported model before its first turn.
No model fallback is allowed after preflight.

### requirement-codex-typed-output

For each typed task, the adapter must pass the task's JSON Schema as `turn/start.outputSchema`.
It must take the terminal answer from the completed turn, parse one JSON value, and validate it with the task's Zod output schema.
Tool output, commentary, partial deltas, and JSON-looking prose must not become task output.
Missing or invalid output must fail the invocation.
The adapter must not add a repair turn or automatic task retry in the first delivery.

### requirement-codex-autonomous-policy

The adapter must set `approvalPolicy: "never"` and workspace-write sandbox settings on thread creation and every turn.
It must restrict writable roots to the runtime workspace and disable network access by default.
Private configuration can enable network access explicitly. It cannot select `dangerFullAccess` in this delivery.
If Codex requests approval or user input, the adapter must fail with `InteractionRequiredError`.
It must not approve, decline, or otherwise answer the request.
It must interrupt the active turn and terminate its owned process if the turn cannot end within a bound.
Cancellation and interaction failure must remain distinct Seqlane outcomes.

### requirement-codex-cancellation-and-disconnect

On cancellation, the adapter must send one `turn/interrupt` for the active turn.
It must wait for `turn/completed` with an interrupted status before it reports confirmed termination.
If interruption or transport termination cannot be confirmed, it must report uncertain activity.
The runtime must then prevent dependent reuse or branch work on that session.
The adapter must correlate every response and notification by request, thread, and turn ID.

### requirement-codex-observability

The adapter must use completed items as the source of tool activity and the completed turn as the source of task outcome.
It must report usage without counting cumulative updates more than once.
It must omit unsupported cost values rather than estimate them.
Raw event payloads, private IDs, prompt text, and credentials must not enter public events or errors.
Diagnostic and Mastra projection failures must not change a successful Codex result.

## Detailed design or contracts

The package boundary is:

```text
Seqlane runtime -> @seqlane/agent-adapter -> @seqlane/codex-adapter
                                                 |
                                                 v
                                       codex app-server over stdio
```

The adapter owns a JSONL parser, a request-ID map, a notification reducer, and thread state.
It must validate each untrusted JSON-RPC message with an owning Zod schema.
It must set line and message-size bounds, reject malformed required fields, and ignore unknown optional events.
It must not depend on error-message text to decide outcomes.

The capability resolver must declare `execute`, `structuredOutput`, `sessionReuse`, `checkpoint`, `fork`, `modelSelection`, and `activity` only after compatibility proof.
It must declare `sessionUi: false` in the first delivery.
The existing runtime must reject a required capability before session or workspace admission.

The first delivery uses one Codex turn per Seqlane invocation.
The adapter sends the validated task request and schema to `turn/start`.
It reduces matching `item/*` and `turn/*` notifications until the matching turn ends.
It treats the final completed agent message as the only output candidate.

The host owns process lifetime. The adapter owns thread lifetime.
The direct-run and persistent-host paths can share the same transport implementation.
Neither path may put Codex thread IDs in Seqlane's canonical run store.

## Failure and edge cases

- Missing executable, incompatible CLI, failed handshake, or unavailable model fails before task submission.
- An approval or user-input request fails through the existing non-interactive error path.
- A failed or interrupted turn cannot publish a checkpoint or a typed result.
- A transport disconnect with an active turn reports uncertain activity until termination is confirmed.
- A response for an unknown request ID or a notification for another thread cannot complete the active invocation.
- Duplicate terminal events cannot emit duplicate metrics, activity completion, or task outcomes.
- A stale or foreign checkpoint fails through the existing runtime checkpoint binding.
- A model change on a reused session fails before `turn/start`.

## Migration

Add Codex as a third private runtime adapter identity.
Keep ACP and OpenCode behavior unchanged.
Do not add Codex fields to public authoring, Plan, runner IPC, or CLI result schemas.

## Verification

- Probe the selected Codex CLI with a controlled app-server and record its version and observed protocol shapes.
- Test JSONL framing, malformed input, request correlation, event ordering, duplicate events, and disconnects.
- Test typed output, model preflight, isolated and reused sessions, exact branches, cancellation, and interaction failure.
- Test direct-run and persistent-host lifecycle with run isolation.
- Check public declarations and serialized boundaries for Codex and Mastra type leaks.
- Run `pnpm test:mapping`, focused tests, typecheck, lint, build, format, and `pnpm docs:validate`.

## Acceptance criteria

- One private configuration selects a working Codex adapter without changing workflow source or Plans.
- An isolated task, ordered reuse, and an exact branch return locally validated typed output.
- Unsupported capabilities and models fail before task execution.
- An interaction request never receives a decision from Seqlane.
- Cancellation either confirms interruption or reports uncertain activity.
- No raw Codex protocol value crosses a public Seqlane boundary.

## Delivery state

Draft only. No Codex adapter or protocol probe is delivered by this document.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- [spec.session-checkpoint-reuse-and-branching](./2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.model-selection-and-session-model-semantics](./2026-09-03-model-selection-and-session-model-semantics.md)
- [task.prove-codex-app-server-protocol](../tasks/2026-09-12-prove-codex-app-server-protocol.md)
- [task.implement-codex-app-server-adapter](../tasks/2026-09-12-implement-codex-app-server-adapter.md)
- [task.integrate-codex-runtime-adapter](../tasks/2026-09-12-integrate-codex-runtime-adapter.md)
- [OpenAI Codex App Server documentation](https://developers.openai.com/codex/app-server)
