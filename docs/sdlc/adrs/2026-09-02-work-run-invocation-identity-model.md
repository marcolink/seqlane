---
id: adr.work-run-invocation-identity-model
title: Distinguish Work, Run, and Invocation Identity
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Distinguish Work, Run, and Invocation Identity

## Context

Seqlane workflows may perform multiple repository mutations and may eventually create multiple commits during one execution.

The same logical engineering objective may also continue across multiple Seqlane executions—for example, an initial dependency repair followed by a later run responding to a new CI failure.

Static Workflow IDs and Task IDs identify definitions, but they cannot uniquely correlate concrete execution or repository artifacts.

A single Run ID also becomes insufficient once one logical unit of work spans multiple CLI executions.

## Decision

Seqlane will distinguish **definition identity** from **execution identity**.

### Definition identity

```text
Workflow ID
Task ID
```

These identify reusable definitions.

### Execution identity

```text
Work
  ↓
Run
  ↓
Invocation
```

#### Work

A **Work** represents one logical engineering objective.

Examples:

```text
repair Renovate React 19 update
resolve migration failure
implement issue XYZ
```

A Work may eventually span multiple Seqlane Runs.

#### Run

A **Run** represents one concrete Seqlane runtime execution.

For CLI execution, a Run normally corresponds to one dedicated runner-process lifetime.

#### Invocation

An **Invocation** represents one execution of a task or nested workflow node within a Run.

Invocation identity is unique to the concrete execution, even when the same static Task definition executes multiple times.

## Correlation Model

```text
Workflow ID / Task ID
      definition

Work ID
  └── Run ID
       └── Invocation ID
            └── resulting artifacts
```

A static Task ID is descriptive provenance only and must never be treated as a unique correlation identifier.

## Git Provenance

Seqlane should eventually make repository commits traceable back to the execution that produced them.

Recommended Git trailers:

```text
Seqlane-Work: work_...
Seqlane-Run: run_...
Seqlane-Invocation: inv_...
Seqlane-Task: apply-renovate-fix
```

`Seqlane-Task` identifies the reusable task definition and is not sufficient for correlation on its own.

Seqlane should eventually retain the reverse mapping from Invocation/Run to commit SHA(s):

```text
Invocation → commit(s)
commit → Work / Run / Invocation
```

## Cross-Run Continuation

A future Run may explicitly continue an existing Work:

```text
Work A
  ├── Run 1
  │     investigate / modify / commit
  └── Run 2
        respond to later failure / commit
```

Work identity survives runner-process and CLI boundaries.

The mechanism for selecting, persisting, or continuing a Work is not defined by this ADR.

## MVP Boundary

The MVP does **not** require:

- persistent Work storage;
- `--work` CLI options;
- cross-run continuation;
- Git trailer injection;
- commit SHA tracking;
- commit provenance queries.

The identity model is established now so later provenance features do not require redefining Run or Task identity.

A first implementation may generate Work and Run IDs with a 1:1 relationship while keeping the concepts semantically distinct.

## Consequences

### Positive

- Multiple commits can be associated with the logical work that produced them.
- Multiple runs can advance one objective without overloading Run identity.
- Runtime events and observability get stable correlation identifiers.
- Static Task IDs remain reusable without becoming ambiguous provenance keys.
- Future replay, continuation, CI reruns, and artifact tracking have a coherent identity hierarchy.

### Negative

- Introduces an identity concept that MVP does not yet fully use.
- Future persistence must define Work lifecycle and lookup semantics.
- Git provenance requires coordination with commit creation.
- Users and tooling must understand the distinction between Work and Run.

## Alternatives Considered

### Static Task ID on commits

Simple but cannot distinguish different executions of the same reusable task.

### Run ID only

Works for one process execution but cannot correlate logical work spanning multiple runs.

### Invocation ID only

Provides precise origin but makes it difficult to group multiple invocations/runs under one objective.

### Git commit SHA as the primary identity

Commits are outputs rather than the identity of the work and do not cover non-commit execution or multiple related commits.

## Constraints

- Work, Run, and Invocation IDs are Seqlane-owned identities.
- Workflow and Task IDs remain definition identities.
- Runtime events carry Run and Invocation identity.
- Future persisted observability carries Work identity when available.
- Task IDs are never used as unique execution correlation keys.
- Cross-run continuation is explicit rather than inferred from task names.

## Decision Test

Reconsider this ADR if Seqlane never needs logical work to span multiple runs or an existing organizational identity should become authoritative instead.

Until then, Work → Run → Invocation is the canonical execution identity hierarchy.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
