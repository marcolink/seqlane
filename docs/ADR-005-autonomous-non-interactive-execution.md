# ADR-005 — Make V1 Workflow Execution Autonomous and Non-Interactive

**Status:** Implemented
**Scope:** Seqlane runtime behavior
**Related:** PRD, RFC 1, Seqlane MVP

## Context

Seqlane is intended to automate complete engineering workflows rather than provide an interactive agent shell.

A workflow such as failed Renovate remediation must be able to investigate, plan, modify, and verify a repository without requiring a developer to repeatedly answer prompts.

Allowing tasks to stop for user input, confirmation, or permission approval would make workflow completion dependent on the CLI session and complicate local automation and eventual CI execution.

It would also require a substantially more complex bidirectional runner protocol and persistent interaction state.

## Decision

Seqlane V1 workflow execution is **autonomous and non-interactive**.

Once a Run begins, it continues until:

```text
success
failure
cancellation
```

without requesting human decisions.

Tasks may not require:

- user questions;
- confirmation prompts;
- permission approvals;
- option selection;
- manual continuation;
- arbitrary runtime input from the CLI.

All information and execution authority required by a workflow must be supplied or configured before it becomes necessary.

If an executor reaches a state that cannot proceed autonomously, the invocation fails deterministically.

## CLI Role

The CLI is not part of workflow decision-making.

After launching the runner, its responsibilities are limited to:

- rendering structured progress/events;
- forwarding cancellation;
- reporting final result and exit status.

The CLI does not choose branches, answer agent questions, approve tool operations, provide task-specific decisions, or mediate retries.

## Permission Handling

OpenCode or any future executor must be configured with an execution policy suitable for autonomous operation.

Seqlane must not silently transform an unresolved permission request into approval.

```text
executor permission required
          ↓
policy resolves autonomously?
      ↙             ↘
    yes             no
     ↓               ↓
 continue           fail
```

## Runner Protocol

The V1 runner protocol does not include generic human interaction messages.

Expected control flow is:

```text
CLI → runner
  RunRequest
  CancelRun

runner → CLI
  lifecycle events
  result/failure
```

Interactive request/response semantics, if ever required, need a separate future decision.

## Consequences

### Positive

- Workflows behave consistently locally and in future headless CI.
- The runner can execute independently after startup.
- IPC remains small and deterministic.
- No workflow is left indefinitely waiting for human input.
- Automation semantics are easier to test.
- Failure is explicit when execution policy is insufficient.

### Negative

- Human-in-the-loop workflows cannot be represented in V1.
- Permission policy must be configured in advance.
- Ambiguous tasks cannot ask the developer for clarification mid-run.
- An executor may fail where an interactive agent session could continue.

## Alternatives Considered

### Interactive by default

Flexible for developers but undermines autonomous workflow execution and creates strong CLI/runtime coupling.

### Optional interaction per task

More flexible but forces the core protocol and lifecycle to support pausing and response routing immediately.

### Automatically approve permission requests

Preserves autonomy but silently increases authority and creates unacceptable security semantics.

## Constraints

- Cancellation is not interactive workflow input.
- Progress rendering must not influence workflow behavior.
- Workflows requiring human decisions are outside V1.
- Runtime components must not add implicit prompts or terminal reads.
- Executor adapters convert unresolved interaction requirements into Seqlane failures.

## Decision Test

Reconsider this ADR if human-in-the-loop workflows become a primary product requirement. Any future interactive mode should be explicit rather than changing autonomous workflow semantics.
