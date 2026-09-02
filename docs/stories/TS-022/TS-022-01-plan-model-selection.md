# TS-022-01 — Carry Model Selection Through Task and Plan Contracts

**Status:** planned

## User outcome

As a workflow author, I can declare a model and optional reasoning on a task,
and the compiled Plan keeps the portable selection without runtime objects.

## Scope

- Add additive model/reasoning fields to core task authoring contracts.
- Normalize them into task Plan nodes and repeat body nodes.
- Preserve legacy Plans and definitions with omitted fields.
- Add serialization and type-boundary tests.

## Out of scope

Runtime defaults, availability, session conflict rules, and OpenCode behavior.

## Acceptance criteria

**Scenario:** *Portable Plan selection*

- **Given:** a task with `model: openai("gpt-5.6-luna")` and `reasoning: "high"`
- **When:** its Plan is built
- **Then:** the node contains only JSON-safe provider/model/reasoning data

**Scenario:** *Legacy omission*

- **Given:** a task without model fields
- **When:** its Plan is built and serialized
- **Then:** it remains valid and contains no executor-specific value

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
