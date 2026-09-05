---
id: adr.dedicated-runner-process
title: Execute Each Seqlane Run in a Dedicated Node Process
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-09-05
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Execute Each Seqlane Run in a Dedicated Node Process

> Superseded by [adr.local-mastra-operational-host](./2026-09-05-local-mastra-operational-host.md).

## Context

Seqlane workflows may be long-running and may execute multiple AI-assisted engineering tasks, invoke shell commands, mutate repositories, and maintain execution state for the duration of a run.

The Seqlane CLI is built with oclif. Executing the workflow runtime directly inside the oclif command process would couple:

- CLI lifecycle;
- terminal rendering;
- signal handling;
- workflow loading;
- Mastra execution;
- executor state;
- OpenCode session state;
- memory lifetime.

Seqlane also needs a clean boundary for cancellation, failure isolation, future observability, and eventual Seqlane-managed OpenCode lifecycle.

## Decision

Each `seqlane run` invocation will execute the complete workflow in a **fresh dedicated Node child process**.

The oclif process remains the foreground supervisor and presentation layer.

```text
seqlane run
     │
     ▼
┌──────────────────────────┐
│ oclif CLI process        │
│                          │
│ command parsing          │
│ runner launch            │
│ event rendering          │
│ signal forwarding        │
│ exit status              │
└────────────┬─────────────┘
             │
             │ Seqlane-owned IPC
             ▼
┌──────────────────────────┐
│ Seqlane runner process  │
│                          │
│ workflow loading         │
│ Plan construction        │
│ Mastra execution         │
│ executor state           │
│ OpenCode session state   │
│ runtime validation       │
└──────────────────────────┘
```

The runner process is:

- foreground;
- owned by the invoking CLI process;
- not detached;
- not persistent;
- not shared between independent runs.

The runner loads and builds the selected workflow itself.

The CLI does not construct the executable Plan and pass it to the runner.

## Runner Ownership

The runner owns all execution-scoped runtime state, including:

- workflow module loading;
- Seqlane Plan construction;
- Plan validation;
- Mastra runtime state;
- executor instances;
- OpenCode client/session state;
- Seqlane Run and Invocation state;
- output validation;
- cancellation state.

The oclif process must not own Mastra or executor runtime state.

## Communication

CLI and runner communicate using a Seqlane-owned serializable protocol.

The protocol must not expose:

- Mastra event types;
- Mastra workflow objects;
- OpenCode SDK objects;
- raw executor-internal types.

For V1, communication is intentionally narrow.

### CLI → runner

```text
RunRequest
CancelRun
```

### Runner → CLI

```text
RunStarted
InvocationStarted
InvocationSucceeded
InvocationFailed
RunSucceeded
RunFailed
RunCancelled
```

Node IPC is the initial transport but is not part of the semantic protocol contract.

## Non-Interactive Execution

The dedicated runner must execute the full workflow autonomously after startup.

The CLI does not participate in workflow decisions and does not provide:

- user input;
- permission approvals;
- confirmations;
- branch decisions;
- task-specific responses.

Cancellation is the only expected runtime control sent by the CLI after the run begins.

## Cancellation

Operating-system signals are handled by the oclif parent and propagated structurally:

```text
SIGINT / SIGTERM
       ↓
      CLI
       ↓
   CancelRun
       ↓
runner cancellation
       ↓
Mastra / Executor abort
       ↓
OpenCode abort
       ↓
runner cleanup
       ↓
exit
```

Hard process termination is a fallback if graceful cancellation cannot complete.

Externally owned OpenCode servers or sessions are not terminated by the runner.

## Consequences

### Positive

- Clear separation between CLI presentation and workflow execution.
- Runtime crashes do not require CLI concerns to be mixed into execution code.
- All run-scoped memory is reclaimed when the runner exits.
- Clean cancellation boundary.
- Natural ownership boundary for future managed OpenCode runtimes.
- Structured runtime events can be consumed by CLI, persistence, observability, or future tooling.
- Runtime can be exercised independently of oclif.
- Independent runs cannot accidentally share in-memory runtime state.

### Negative

- Requires IPC serialization and error handling.
- Adds process startup overhead.
- Debugging spans parent and child processes.
- CLI and runtime package boundaries must remain synchronized.
- Workflow inputs, errors, events, and results crossing the boundary must be serializable.

## Alternatives Considered

### Execute directly inside the oclif command

Simpler initially, but couples presentation and execution lifecycles and makes later isolation, cancellation, and runtime ownership harder to introduce.

### Node `worker_threads`

Provides concurrency but shares the same process-level environment and offers a weaker isolation/lifecycle boundary than a child process.

### Persistent Seqlane daemon

Could amortize startup cost and support background work, but introduces lifecycle, versioning, state, security, and operational complexity that Seqlane does not require.

### Detached/background child process

Would enable runs to outlive the CLI, but conflicts with V1's foreground, autonomous, single-invocation execution model.

## Constraints

- Every `seqlane run` receives a fresh runner process.
- Runner reuse is not allowed in V1.
- No persistent Seqlane daemon is introduced.
- Runner protocol messages must be Seqlane-owned and serializable.
- The runtime package must remain usable independently of oclif.
- The CLI must not contain Mastra execution state.
- The runner must terminate after success, failure, or cancellation.

## Decision Test

This ADR should be reconsidered if:

- process startup overhead becomes material relative to normal workflow execution;
- a future execution model requires runs to survive the invoking CLI process;
- remote execution becomes the primary runtime model;
- the IPC boundary materially prevents required workflow functionality.

Those cases should result in a new ADR rather than silently weakening this boundary.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
