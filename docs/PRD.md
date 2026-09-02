# PRD — Seqlane

**Status:** Draft  
**Purpose:** Define what Seqlane must provide to users as a product. Technical architecture and implementation choices are defined in the RFCs and ADRs.

## 1. Product Summary

Seqlane enables engineers to define, reuse, compose, and execute multi-step software-engineering workflows.

A workflow coordinates discrete tasks such as investigation, planning, implementation, and verification while using the capabilities and context already available in the target repository.

Seqlane is intended for workflows that can execute autonomously from a defined input to either success or failure.

## 2. Target Users

### Workflow users

Engineers who want to execute an existing engineering workflow without manually orchestrating each step.

### Workflow authors

Engineers who want to:

- compose existing tasks and workflows;
- create additional tasks;
- define opinionated engineering processes;
- share those processes at repository or user level.

### Platform and productivity teams

Teams that provide reusable engineering capabilities and common workflows across repositories.

## 3. Core Product Experience

A user should be able to discover an available workflow and execute it from the command line:

```bash
seqlane list

seqlane run fix-renovate-update \
  --input '{ ... }'
```

Once execution starts, Seqlane runs the entire workflow autonomously.

The user receives progress information and a final success or failure result but is not required to make decisions during execution.

## 4. Product Requirements

### PR1 — Define reusable tasks

Authors can define units of engineering work with explicit inputs and outputs. Task outputs can be consumed by subsequent tasks.

### PR2 — Compose workflows

Authors can combine existing tasks into larger workflows without recreating their implementation. Workflows themselves can be reused as building blocks for other workflows.

### PR3 — Extend existing automation

Authors can introduce new tasks directly when existing capabilities are insufficient. Creating a one-off or specialized task must not require registering it with a central service or catalog first.

### PR4 — Repository-level workflows

Repositories can provide opinionated tasks and workflows appropriate to that codebase.

### PR5 — User-level workflows

Users can maintain reusable tasks and workflows that are available across repositories. Repository and user capabilities may coexist. Ambiguous names must not be resolved silently.

### PR6 — Preserve repository agent capabilities

Seqlane must respect and use the repository's existing agent environment, including its instructions, skills, documentation, tools, and other supported capabilities. Seqlane-specific additions should complement rather than replace repository context.

### PR7 — Autonomous execution

After a workflow starts, it must execute until success, failure, or cancellation without requesting user input, confirmations, or permission decisions. A workflow that cannot proceed autonomously must fail clearly.

### PR8 — Explicit task boundaries

Intermediate results passed between workflow stages must have explicit contracts. Externally generated results must be validated before they can become inputs to subsequent stages.

### PR9 — CLI-first operation

The initial Seqlane product is operated through a command-line interface. Users must be able to discover workflows, inspect a workflow plan, run a workflow, observe execution progress, cancel execution, and receive the final result.

### PR10 — Coding-agent execution

The initial product must support workflows whose tasks are executed by OpenCode. Seqlane should preserve the OpenCode environment already associated with the repository.

### PR11 — Existing OpenCode environment

For the MVP, Seqlane may require connection to an already-running OpenCode instance. Requiring users to manage OpenCode separately is an MVP limitation, not the intended long-term product experience.

Seqlane should eventually be capable of managing the normal OpenCode execution lifecycle itself while retaining the ability to connect to an existing environment or session.

### PR12 — Observable execution

Users must be able to understand at minimum which workflow is running, which task is currently executing, which tasks succeeded or failed, and whether the workflow succeeded, failed, or was cancelled.

## 5. Initial Reference Workflow

The initial reference workflow is **Fix a failed Renovate dependency update**.

The product must make it possible to define a workflow that:

1. receives dependency/update failure context;
2. investigates the failure;
3. determines a remediation;
4. modifies the repository;
5. verifies the resulting state;
6. returns a structured result.

The complete workflow must execute without human intervention after it starts. Seqlane itself must remain generic and contain no Renovate-specific behavior.

## 6. Product Principles

- **Composition over monolithic prompts.**
- **Reuse over duplication.**
- **Repository context remains authoritative.**
- **Strong contracts between stages.**
- **Bounded autonomy.**

## 7. Initial Product Scope

The first usable version requires:

- CLI execution;
- reusable tasks;
- reusable workflows;
- repository workflow discovery;
- user workflow discovery;
- workflow composition;
- strong input/output contracts;
- OpenCode task execution;
- preservation of repository OpenCode context;
- autonomous non-interactive execution;
- progress and final-result reporting;
- cancellation.

## 8. Out of Scope for Initial Product

Not required initially:

- graphical UI;
- interactive workflows;
- human approval steps;
- multiple coding-agent backends;
- persistent or multi-day workflows;
- automatic retries and repair loops;
- parallel execution;
- scheduled or event-triggered execution;
- cross-run continuation;
- commit provenance;
- persistent execution history;
- advanced observability;
- managed OpenCode lifecycle in the MVP.

## 9. Product Success Criteria

The initial product is successful when:

1. an engineer can discover and run an existing workflow with minimal setup;
2. a workflow author can compose a new workflow from existing tasks and add specialized tasks where required;
3. workflows can be shared at repository and user level;
4. workflow stages exchange validated, well-defined results;
5. execution completes autonomously without requiring user intervention;
6. a real failed Renovate update can be investigated, repaired, and verified end-to-end through Seqlane.

## 10. Relationship to Technical RFCs

The PRD defines product behavior. RFCs own the execution engine, Plan representation, process boundaries, IPC, runtime identity, session implementation, resource scheduling, retry mechanics, observability protocol, and package architecture.
