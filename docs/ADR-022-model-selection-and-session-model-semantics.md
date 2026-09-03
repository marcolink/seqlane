# ADR-022 — Model Selection and Session Model Semantics

**Status:** Accepted
**Scope:** Executor-neutral model identity, reasoning effort, session model
pinning, model availability preflight, and OpenCode fork initialization
**Related:** ADR-008, ADR-018, ADR-021

## Context

Seqlane needs explicit model selection for agent tasks while keeping workflow
authoring independent from executor SDKs. A model is part of the logical
Seqlane session configuration. If a continuation could silently change that
configuration, the same session history would produce different behavior.

The current OpenCode adapter can create, reuse, and fork sessions. It does not
yet expose a Seqlane-owned model contract, model availability capability, or a
safe fork initialization sequence. Reasoning effort must travel with model
selection but must remain an executor-neutral value.

## Options Considered

### Put provider SDK model objects in task definitions

This would provide provider features directly, but it would leak credentials,
runtime objects, and executor dependencies into public contracts and Plans.
Rejected.

### Mirror every provider model into strict generated unions

This would provide broad autocomplete, but the catalog is large and changes
often. It would also make every provider a public compile-time commitment.
Rejected for now. OpenAI and Anthropic get generated strict IDs; other
providers use the generic string escape hatch.

### Use a small model descriptor and pin it to logical sessions

This keeps Plans JSON-safe and portable. Runtime adapters validate availability
and translate the descriptor to native requests. Session rules remain stable
even when an adapter supports prompt-level model changes. Chosen.

## Decision Outcome

Seqlane owns an immutable JSON-safe `ModelRef` with `provider` and `model`
strings. Core exposes strict `openai()` and `anthropic()` helpers backed by
committed models.dev tuples. `model("provider/id")` supports unknown providers
and model IDs, preserving slashes after the first separator.

Core also owns the finite `ReasoningEffort` union:

```ts
type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type ModelSelection = {
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
};
```

Model selection is nested inside the session declaration because models are
bound to logical sessions. Isolated sessions and branches may declare a
selection. Reuse sessions never accept a selection; they inherit the source
session's pinned selection. The Plan stores only this Seqlane-owned descriptor.
No provider SDK object, credential, OpenCode object, or Codex type crosses the
core or Plan boundary.

The effective model selection is immutable for each logical session:

- An isolated session may select a model. Without one, the adapter resolves
  its default and Seqlane records the effective selection.
- A continuation inherits the effective selection. An explicit equal
  selection is accepted; a different selection fails Plan validation.
- A branch creates a new logical session. It inherits the parent selection by
  default and may select another selection. The branch is then pinned.
- A reuse declaration cannot contain a model selection.
- Separate child sessions may use different selections.
- Adapter support for changing a model during a prompt does not weaken these
  rules. Seqlane only changes the selection while creating a new session.

Before execution, the runtime collects distinct required selections, asks the
selected executor for its normalized available-model catalog, resolves omitted
models through the executor default capability, and fails deterministically
before any invocation starts when a required model is unavailable. Errors name
the provider/model, executor, and useful alternatives.

For OpenCode branches, the adapter forks at the recorded checkpoint, applies
the selected model and reasoning configuration, and sends the first prompt
only after configuration succeeds. The scheduler sees the branch only after
this initialization completes.

Every invocation records its effective model selection in Seqlane-owned
observability data, including inherited selections. Model changes are visible
only with the creation of a new logical session.

## Consequences

### Positive

- Workflow Plans remain portable and serializable.
- Known OpenAI and Anthropic IDs get typo-resistant TypeScript support.
- Unknown providers remain usable without catalog churn.
- Session history has one stable model identity.
- Availability failures happen before task execution.
- OpenCode fork initialization cannot send a prompt to a partially configured
  branch.

### Negative

- Model availability is runtime-dependent and cannot be proved by TypeScript.
- The executor contract must expose normalized model discovery/defaults.
- A model change requires an explicit branch or isolated session.
- Generated catalogs need periodic updates.
- Reasoning values are portable labels; adapters must define how they map to
  native capabilities.

## Follow-up Constraints

- Keep executor SDK types and native model objects private to adapters.
- Keep Codex out of this implementation; add a future adapter against this
  contract if needed.
- Do not add automatic fallback, pricing, credential management, or reasoning
  policy beyond the finite value contract.
- Reuse ADR-021 session/checkpoint lifecycle and admission mechanisms.
- Where proposed ADR-018 conflicts with direct model selection or session model
  pinning, this ADR governs. Runtime-owned agent profiles remain a separate
  concern.

## Revisit Conditions

Revisit when another adapter needs provider-specific reasoning dimensions,
catalog metadata in Plans, automatic fallback, session model mutation, or
cross-Run session persistence.
