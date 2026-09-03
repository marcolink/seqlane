---
id: task.model-observability
title: Record Effective Model Selections in Observability
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Record Effective Model Selections in Observability

> Migrated from implementation story `TS-022-06`.

## User outcome

As an operator, every invocation shows the effective provider, model, and
reasoning, including inherited values.

## Scope

- Extend Seqlane-owned invocation metrics/events with effective selection.
- Populate values for explicit, defaulted, inherited, and branched sessions.
- Keep native provider payloads private.
- Add serialized event compatibility and renderer coverage where required.

## Out of scope

Raw provider objects, pricing, token policy, and Codex event support.

## Acceptance criteria

**Scenario:** *Inherited observability*

- **Given:** an invocation continues a model-pinned session
- **When:** its completion event is emitted
- **Then:** the event contains the inherited effective selection

**Scenario:** *Portable event*

- **Given:** an event is serialized
- **When:** a consumer parses it
- **Then:** it contains only Seqlane-owned JSON-safe model data

## Source

- [adr.model-selection-and-session-model-semantics](../adrs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)

## Traceability

- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
