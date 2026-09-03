---
id: adr.invocation-admission-and-workspace-coordination
title: Coordinate Invocation Admission Through DAGs, Sessions, and Workspaces
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Coordinate Invocation Admission Through DAGs, Sessions, and Workspaces

## Decision

Seqlane admits an invocation only when its dependencies succeeded, its session
is available, its workspace policy is compatible with active invocations, and
global concurrency capacity is available.

Tasks declare only:

```ts
workspace: "shared" | "exclusive";
```

Omission resolves to `exclusive`. `shared` tasks may overlap only with other
shared tasks. An exclusive task requires an empty workspace; it blocks shared
and exclusive tasks. Queue order is invocation creation order.

Workspace policy is an author assertion about permitted concurrency. It is not
a security boundary and does not guarantee filesystem, shell, or tool behavior.
Seqlane does not inspect prompts, commands, tools, or runtime configuration to
validate the assertion.

The runtime holds admission through requests, retries, child sessions, tracked
processes, cancellation, and cleanup. Session serialization and DAG semantics
are unchanged.

## Permission boundary

Seqlane has no per-task permission model. It does not define, merge, validate,
enforce, fingerprint, or expose executor permissions. Selected runtime
configuration is authoritative for tools, filesystem, shell, network, MCP,
skills, approvals, and runtime-native rules.

An unsupported interactive runtime request in a non-interactive Run fails
deterministically. Seqlane never approves it.

## Observability

Admission events report the resolved workspace policy, `workspace_unavailable`
waits, conflicting invocation identity when known, and admission/release. No
permission policy or multiple-writer diagnostic is emitted.

## Consequences

- Runtime configuration must be prepared for autonomous execution.
- Authors choose the correct policy for the configured runtime and task work.
- Per-task runtime permissions remain intentionally deferred.

## Implementation audit

Current implementation uses workspace policy only: `shared` tasks overlap with
other shared tasks; `exclusive` tasks serialize all workspace work. Admission
is deterministic, respects DAG and session constraints, and is held through
tracked invocation lifetime.

Seqlane no longer owns executor permissions. Runtime configuration controls
authority and unsupported interaction requests fail via the generic
non-interactive path. The previous capability-enforcement and
multiple-writer-diagnostic audit is obsolete.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
