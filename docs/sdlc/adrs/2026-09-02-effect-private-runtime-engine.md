---
id: adr.effect-private-runtime-engine
title: Use Effect as Seqlane's Private Runtime Engine
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Use Effect as Seqlane's Private Runtime Engine

> Superseded by [the full Effect v4 runtime decision](../rfcs/2026-10-21-effect-v4-migration.md).
> This earlier decision proposed a bounded sequential replacement. It is not
> evidence that the current Effect v4 contract was delivered at that time.

## Context

Seqlane owned Plan meaning, binding resolution, schemas, identity, execution
policy, errors, and events. A separate workflow model added translation and
lifecycle work without owning those domain contracts.

The proposal sought a private foundation for cancellation and resource lifetime
while preserving public contracts. It deliberately limited the first change
to sequential execution parity.

## Historical decision

Use Effect primitives behind the private runtime boundary. Keep public
contracts Zod-owned and retain existing task callbacks, cancellation signals,
and Seqlane outcomes. Do not add durable replay or automatic action retries.

The current replacement expands that bounded proposal into one scoped Effect v4
program across CLI, direct, HTTP, and MCP callers. It owns concurrency,
admission, processes, native SDK bridges, hosted SQL history, and telemetry.
The earlier implementation seams and package-version advice are retired.

## Alternatives considered

- Keep a separate workflow model: retained unnecessary translation and lifecycle work.
- Build a Promise scheduler: required custom interruption and resource ownership.
- Add durable workflow machinery: introduced replay and persistence decisions
  beyond the original foreground-run requirement.

## Retained rationale

Effect supplies execution mechanisms. Seqlane retains domain policy and public
meaning. Engine types stay out of core, Plans, IPC, and workflow authoring.
Persistence and replay require explicit behavior and side-effect policy.

## Delivery state

Superseded decision. Neither its date nor its status proves implementation of
this proposal or the current migration on the target branch.

## Traceability

- [rfc.seqlane-technical-architecture — Original technical architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [Replacement runtime decision](../rfcs/2026-10-21-effect-v4-migration.md)
- [Current execution and operations contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
