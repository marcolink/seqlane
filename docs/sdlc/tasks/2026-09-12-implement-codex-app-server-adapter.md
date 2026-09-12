---
id: task.implement-codex-app-server-adapter
title: Implement the Codex App-Server Adapter
status: in-progress
owners:
  - core
created: 2026-09-12
updated: 2026-09-12
upstream:
  - spec.codex-app-server-adapter
supersedes: []
---

# Implement the Codex App-Server Adapter

## Objective

Implement one private `AgentAdapter` that maps run-scoped Codex threads and turns to Seqlane tasks.

## Dependencies

- [task.prove-codex-app-server-protocol](./2026-09-12-prove-codex-app-server-protocol.md)

## Upstream requirements

- [requirement-codex-owned-lifecycle](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-owned-lifecycle)
- [requirement-codex-session-semantics](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-session-semantics)
- [requirement-codex-typed-output](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-typed-output)
- [requirement-codex-autonomous-policy](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-autonomous-policy)
- [requirement-codex-cancellation-and-disconnect](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-cancellation-and-disconnect)
- [requirement-codex-observability](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-observability)

## Scope

- Add the private `@seqlane/codex-adapter` package.
- Implement bounded JSONL transport, Zod message schemas, and request correlation.
- Implement isolated threads, ordered reuse, completed-turn checkpoints, and exact forks.
- Map model selection, task schema, terminal output, activity, metrics, and errors.
- Interrupt active turns on cancellation or interaction requests.
- Report uncertain activity when termination cannot be confirmed.

## Out of scope

- Runtime configuration and factory registration.
- Public authoring or Plan changes.
- Cross-run thread attachment, external transport, session UI, or interactive approval handling.
- Prompt repair and automatic retries.

## Implementation plan

1. Build the transport from the proved protocol fixtures.
2. Add one adapter session state machine for thread and turn lifecycle.
3. Add schema and model translation with local output validation.
4. Add cancellation, interaction failure, and disconnect handling.
5. Add normalized metrics and activity without raw Codex values in public output.

## Affected areas

- `libs/codex` private package
- workspace manifests and lockfile
- adapter integration fixtures

## Verification

- Test malformed and oversized JSONL messages, wrong IDs, duplicate terminal events, and disconnects.
- Test isolated, reuse, checkpoint, and exact fork behavior.
- Test structured output validation and unsupported model or reasoning selection.
- Test approval and user-input requests without a Seqlane decision response.
- Test cancellation with confirmed and unconfirmed termination.
- Run package tests, test mapping, typecheck, lint, and build.

## Completion criteria

- The adapter satisfies the existing private `AgentAdapter` contract.
- It advertises only operations proved by the pinned Codex CLI.
- Every turn has one terminal Seqlane result or a typed failure.
- No raw Codex protocol or secret crosses a stable Seqlane boundary.

## Outcome

The private `@seqlane/codex-adapter` package is implemented with bounded JSONL
transport, strict JSON-RPC and initialize validation, advisory Codex version
checks, typed output, session reuse, checkpoints, exact forks, correlated turn
events, activity lifecycle reduction, bounded turn payloads, cancellation, and
non-interactive interaction failure. Runtime registration and live protocol
confirmation remain follow-up work.

## Delivery state

The implementation is present in the current worktree. No delivery commit is
recorded yet.

## Traceability

- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
- [task.prove-codex-app-server-protocol](./2026-09-12-prove-codex-app-server-protocol.md)
