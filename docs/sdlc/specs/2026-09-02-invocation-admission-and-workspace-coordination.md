---
id: spec.invocation-admission-and-workspace-coordination
title: Invocation Admission and Workspace Coordination
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - adr.invocation-admission-and-workspace-coordination
supersedes: []
---

# Invocation Admission and Workspace Coordination

> Migrated from legacy technical specification `TS-020`.

## Contract

`seqlane-core` owns `WorkspacePolicy = "shared" | "exclusive"` and the Zod
schema. Task definitions may omit `workspace`; Plan construction serializes
`exclusive`. Old `none`, `read`, and `write` values and permission fields are
rejected at TypeScript and Plan-validation boundaries.

## Runtime behavior

The private runtime locks one workspace resource per Run. Shared admission can
coexist only with shared admission. Exclusive admission requires no active
workspace invocation. It is acquired before session admission and remains held
until the invocation and tracked effects terminate. Session locks, DAG ordering,
cancellation, and deterministic queues remain intact.

Runtime adapters receive no Seqlane permission policy. They use runtime-owned
configuration unchanged. Interactive requests use the generic non-interactive
failure path.

## Event behavior

`invocation.progress` records workspace policy when admission waits, is acquired,
or is released. Waiting due to workspace contention uses
`workspace_unavailable` and includes the known blocking invocation. The
serialized contract contains no permission fields or writer diagnostics.

## Verification

Run from the repository root:

```text
pnpm test:mapping
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
git diff --check
```

## Traceability

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
