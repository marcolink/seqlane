# TS-022-01 — Carry Session Model Selection Through Plan Contracts

**Status:** completed

## User outcome

As a workflow author, I can declare a model and optional reasoning inside a
new session declaration, and the compiled Plan keeps the portable selection
without runtime objects.

## Scope

- Add model/reasoning fields only to isolated and branched session contracts.
- Normalize them into nested Plan session policies and repeat body nodes.
- Keep reuse session declarations model-free.
- Preserve legacy Plans and definitions with omitted fields.
- Add serialization and type-boundary tests.

## Out of scope

Runtime defaults, availability, session conflict rules, and OpenCode behavior.

## Acceptance criteria

**Scenario:** *Portable Plan selection*

- **Given:** a task with `session: isolated({ model: openai("gpt-5.6-luna"), reasoning: "high" })`
- **When:** its Plan is built
- **Then:** the node contains only JSON-safe provider/model/reasoning data
  nested under its session policy

**Scenario:** *Legacy omission*

- **Given:** a task without model fields
- **When:** its Plan is built and serialized
- **Then:** it remains valid and contains no executor-specific value

**Scenario:** *Reuse cannot select*

- **Given:** a task continues a checkpoint with `reuse(checkpoint)`
- **When:** authoring attempts to add a model selection
- **Then:** TypeScript rejects the declaration

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
