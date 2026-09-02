# TS-022-06 — Record Effective Model Selections in Observability

**Status:** planned

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

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
