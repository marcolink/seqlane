# TS-022-00 — Define Model Refs, Reasoning, and Catalog Helpers

**Status:** completed

## User outcome

As a workflow author, I can use strict OpenAI/Anthropic helpers, generic model
references, and an optional portable reasoning effort without importing an
executor SDK.

## Scope

- `ModelRef`, `ReasoningEffort`, `ModelSelection`, and Zod schemas.
- Strict OpenAI and Anthropic generated catalog helpers.
- Generic `model("provider/id")` parsing.
- `@seqlane/core/models` package export and focused tests.
- Callable models.dev catalog updater.

## Out of scope

Task/Plan integration, runtime availability checks, session pinning, and
OpenCode request behavior.

## Acceptance criteria

**Scenario:** *Known provider helper*

- **Given:** a generated OpenAI or Anthropic model ID
- **When:** the provider helper is called
- **Then:** it returns a frozen `{ provider, model }` descriptor

**Scenario:** *Unknown provider escape hatch*

- **Given:** `model("acme/my/custom-model")`
- **When:** the ref is created
- **Then:** provider is `acme` and model is `my/custom-model`

**Scenario:** *Reasoning validation*

- **Given:** a model selection
- **When:** reasoning is parsed
- **Then:** only the seven ADR-022 values are accepted

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
