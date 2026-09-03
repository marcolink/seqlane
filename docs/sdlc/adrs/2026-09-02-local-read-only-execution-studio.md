---
id: adr.local-read-only-execution-studio
title: Provide a Local Read-Only Execution Studio
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Provide a Local Read-Only Execution Studio

## Context

The CLI can render one run in a terminal. It cannot show multiple concurrent
runs in a browser or show each run as a dependency graph.

Seqlane already emits ordered, Seqlane-owned runner events. These events
include Work, Run, and Invocation identities. They do not yet identify the
Plan node for an invocation. They also do not carry resolved task input or
validated task result values for an inspector.

The first Studio release is an inspection tool. Users can watch active runs.
They cannot edit workflows, control execution, or retain run history.

adr.dedicated-runner-process rejects a persistent Seqlane daemon. Studio must not create one as an
unplanned side effect.

## Decision

Seqlane will provide a local, read-only Studio service. A user starts it in
the foreground. It binds only to a loopback address and stops when its owning
command stops.

Studio holds an in-memory registry of the runs that Seqlane CLIs register
with that service. It can list and show many concurrent runs from one machine.
It does not discover arbitrary operating-system processes.

The existing runner-to-CLI IPC remains the runner transport. The CLI forwards
a copy of each canonical runner event to the selected Studio service. Studio
delivery is best effort. A Studio error, a slow browser, or a Studio shutdown
must not change execution, cancellation, or the CLI exit status.

```text
runner process
      │ Seqlane IPC
      ▼
CLI supervisor ── runner events ──► local Studio service
                                         │ snapshot + SSE
                                         ▼
                                      browser clients
```

The service provides:

- a current-run list with one summary per `runId`;
- a snapshot for one registered run; and
- a Server-Sent Events stream for live updates to that run.

The service keeps a bounded, in-memory event buffer for each active run. A
browser uses the snapshot and event sequence to reconnect after a short
disconnect. A service restart erases all run data. V1 does not promise
history, replay after restart, or storage in the browser.

Every run ID must be unique on the machine. A workflow ID or task ID is never
a run key. Studio uses `runId` to isolate summaries, graph state, event order,
and browser subscriptions.

### Graph and inspection model

Studio shows the actual invocation graph. A graph node uses `invocationId` as
its instance identity. An invocation topology event must also include the
Seqlane `planNodeId` that produced the invocation. This keeps one Plan node
distinct from repeated runtime invocations.

Dependency edges come from invocation dependency IDs. Workflow containment
uses parent invocation identity. Studio does not infer either relationship
from task names or event order.

The graph shows state and a short label. A user opens the node inspector to
see structured input, result, error, timing, and execution output.

The runner protocol will add these Seqlane-owned event categories:

- `invocation.input` for a resolved task input;
- `invocation.result` for a validated task result; and
- `planNodeId` on invocation topology data.

The input and result values are JSON values. A value event must state whether
the value is present, redacted, truncated, or omitted. Seqlane redacts and
limits values before they cross the runner boundary. Agent or executor text
continues to use `invocation.output`; it is not a structured task result.

Studio uses only Seqlane-owned Plans, identities, and runner events. It must
not expose Mastra, OpenCode, or any executor-specific field.

### Access boundary

Studio accepts connections only on loopback. It has no remote deployment,
multi-user access, or remote authentication in V1. The foreground service
uses a per-session capability to accept CLI event delivery and browser access.

## Options Considered

### A persistent local daemon with stored run history

A daemon could retain history and collect runs without a foreground Studio
command. It adds process lifecycle, upgrade, storage, and access-control work.
It also conflicts with adr.dedicated-runner-process. This option is rejected for V1.

### A browser connected directly to each runner

This avoids a local service. It cannot provide one run list for parallel CLI
processes. A browser disconnect also loses its connection to each runner.
This option is rejected.

### A foreground local Studio service

A local service can collect registered runs, keep one live view for each run,
and fan out updates through Server-Sent Events. Its lifetime stays explicit
and separate from runner execution. This option is chosen.

### A remote Studio service

A remote service requires user identity, network access, durable storage, and
a data-retention policy. This option is outside V1.

## Consequences

### Positive

- Users can list and inspect concurrent local runs in one browser view.
- The browser receives live updates without polling.
- The graph represents Seqlane dependencies and invocation instances.
- Input and result inspection use structured Seqlane data, not log parsing.
- The runner and Plan remain executor-neutral.
- Storage can be added later behind the service boundary.

### Negative

- The user must start and keep the Studio service open.
- A service restart erases the active run registry and event buffers.
- The CLI must forward events in addition to its terminal renderer.
- Inputs and results require strict redaction and size limits.
- The Studio UI needs its own projection and graph layout.

## Required Follow-up

Before implementation, create an implementation specification that defines:

- Studio command lifetime, service discovery, and session-capability transfer.
- The local registration, snapshot, and Server-Sent Events contracts.
- Event ordering, bounded buffering, disconnect handling, and backpressure.
- `planNodeId`, `invocation.input`, and `invocation.result` protocol schemas.
- Input/result redaction, truncation, omission, and size-limit rules.
- Tests for two parallel runs, repeated Plan nodes, reconnect, redacted values,
  and a Studio failure that does not affect a runner result.
- Browser accessibility for graph navigation, state, and inspector content.

## Constraints

- Studio is read-only in V1.
- Studio is a foreground local service, not a persistent Seqlane daemon.
- All concurrent-run state is keyed by Seqlane `runId`.
- The CLI forwards canonical runner events without modifying their meaning.
- The browser does not poll for run updates.
- Runner events remain serializable and Seqlane-owned.
- No executor-specific type, configuration, or value crosses the Studio boundary.
- Seqlane redacts and bounds display values before Studio receives them.
- Studio failures cannot change runtime execution or CLI exit status.
- V1 has no durable run history or browser-side persistence.

## Revisit Conditions

Create a new ADR when Studio must retain history across service restarts,
support remote or multi-user access, control runs, or outlive its foreground
command.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
