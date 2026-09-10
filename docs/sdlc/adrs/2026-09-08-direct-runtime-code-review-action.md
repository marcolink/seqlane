---
id: adr.direct-runtime-code-review-action
title: Run Trusted Code-Review Actions Through a Direct Runtime Service
status: accepted
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - adr.effect-private-runtime-engine
  - adr.dedicated-runner-process
  - adr.seqlane-action-library-boundary
  - adr.executor-neutral-workflow-authoring
  - adr.autonomous-non-interactive-execution
supersedes: []
---

# Run Trusted Code-Review Actions Through a Direct Runtime Service

## Context

The trusted code-review workflow currently contains admission, GitHub API
calls, review-state parsing, Seqlane workflow input construction, CLI
invocation, event replay, metric calculation, publication, and marker cleanup.
This makes the workflow difficult to test and leaves application behavior in
YAML shell steps.

The runtime also has no supported application-facing API for a trusted caller.
`libs/seqlane-runtime/src/runner/run.ts:startRun` currently combines workflow
loading, runtime-profile resolution, Plan compilation, model and session
preflight, execution, cancellation, event forwarding, and runner-host exit.
The Effect engine is private and must remain private.

The code-review Action runs from a trusted workflow revision. Its workflow is
trusted static source. The pull-request checkout is untrusted review data and
must not provide workflow code, Action code, or dynamic imports. The Action
needs to invoke a bundled review workflow without installing or building the
consumer checkout and without starting the CLI runner.

## Decision

Extract an application-facing runtime service named `startWorkflowRun` from
the runner orchestration. The service accepts a trusted `BuiltWorkflow`,
candidate workflow input, the existing runtime-profile reference with its
explicit workspace path, a Seqlane event sink, and optional cancellation and
runtime-session notification dependencies. A caller can also supply a complete
Work and Run identity pair. Otherwise, the service allocates a fresh pair. It
validates the input with the workflow schema. It returns a typed active-run
handle with Work and Run identities, an idempotent cancel operation, and the
existing typed Seqlane run outcome.

The service performs the shared runtime lifecycle: runtime-profile resolution,
compilation, model and session preflight, event emission, execution,
cancellation, and outcome mapping. It does not load a workflow path, read
untrusted modules, own an IPC host, render CLI output, or exit a process.
Effect values, resolved runtime internals, runner-host types, IPC messages, and
CLI presentation types do not cross this service boundary.

`startRun` remains the adapter for `seqlane run`. It loads the selected
workflow, allocates identities, calls `startWorkflowRun`, forwards events
through runner IPC, maps runner cancellation, and exits the fresh runner
process. Runtime-profile resolution belongs to the shared service. `seqlane
run` therefore keeps the fresh runner required by
[adr.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md).
Trusted embedded applications can call the runtime service directly.

Add the code-review application in the private
`libs/action-code-review` package. Add a thin Node 24 JavaScript Action at
`actions/code-review` with committed self-contained main and post bundles. The
Action imports its statically bundled workflow from trusted Action source and
calls `startWorkflowRun` directly. It does not call `apps/seqlane-cli`, spawn
the CLI or runner, dynamically import workflow code from the review target, or
replay events through the CLI.

The workflow keeps admission, permissions, pull-request concurrency, runner
and timeout settings, trusted and untrusted checkouts, and composition of the
existing setup-opencode, opencode-server, zvec-grep-server, and ripwire-server
Actions. Those service Actions retain service startup and post cleanup. The
code-review Action owns review context, prior-state parsing, marker lifecycle,
direct execution, event and metric processing, publication, bounded outputs,
and marker cleanup.

## Alternatives considered

### Keep CLI execution in the workflow

This keeps the current entrypoint but requires a dependency install, a CLI
build, a fresh runner, event replay, and many shell steps in the workflow. It
does not provide a reusable trusted application boundary. Rejected.

### Put the review in the Action entrypoint

This shortens the workflow but creates a large entrypoint that mixes Action
Toolkit concerns, GitHub I/O, review policy, and Seqlane execution. It also
makes deterministic review behavior harder to test. Rejected.

### Add a generic Action or runtime framework

This adds abstractions before a second Action needs the same application
contract. It weakens ownership and can leak platform types into Seqlane
packages. Rejected.

### Keep `startRun` as the application API

This exposes runner loading, IPC, and host exit concerns to embedded callers.
It prevents a trusted Action from using the runtime without a runner. Rejected.

### Extract `startWorkflowRun` and use an Action-specific library

This gives trusted applications a narrow runtime contract, keeps the CLI
runner boundary intact, and gives the review Action a testable application
boundary. Chosen.

## Consequences

### Positive

- Trusted applications can run built workflows in-process.
- The CLI keeps its fresh-runner and IPC isolation contract.
- Runtime lifecycle behavior has one application-facing implementation.
- The code-review workflow becomes a small composition layer.
- Review policy and GitHub I/O become testable outside Actions Toolkit.
- The Action bundle does not depend on consumer checkout installation.
- Seqlane authoring, Plans, events, and executor-neutral contracts stay clean.

### Negative

- The runtime needs a new boundary with explicit dependency contracts.
- The Action needs a private package, bundle build, and bundle-drift checks.
- The migration moves substantial behavior from YAML into typed application
  code.
- The Action must maintain explicit ports for GitHub, Git, files, and runtime
  events.

### Security consequences

- Only the trusted workflow revision can provide Action and workflow source.
- The review target supplies data and bounded Git evidence, never executable
  review workflow source.
- The Action must preserve the existing no-target-code-execution contract.
- GitHub writes require live-state and stale-write checks at the Action
  boundary.
- Action metadata must define an `always()` post entrypoint for marker cleanup.
  Main-path cleanup and post cleanup must be idempotent and must not remove a
  marker owned by a newer run.

## Traceability

- [adr.effect-private-runtime-engine](./2026-09-02-effect-private-runtime-engine.md)
- [adr.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
- [adr.seqlane-action-library-boundary](./2026-09-06-seqlane-action-library-boundary.md)
- [adr.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
