---
id: task.model-contracts
title: Define Model Refs, Reasoning, and Catalog Helpers
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Define Model Refs, Reasoning, and Catalog Helpers

> Migrated from implementation story `TS-022-00`.

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
- **Then:** only the seven adr.model-selection-and-session-model-semantics values are accepted

## Source

- [adr.model-selection-and-session-model-semantics](../adrs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)

## Traceability

- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
