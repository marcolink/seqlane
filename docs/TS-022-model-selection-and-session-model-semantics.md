# TS-022 — Model Selection and Session Model Semantics

**Status:** Ready for implementation
**Implements:** ADR-022
**Depends on:** ADR-008, ADR-016, ADR-021
**Adapter scope:** OpenCode only

## 1. Objective

Add a portable model-selection contract and enforce immutable effective model
selection across isolated, reused, branched, and child sessions. Resolve and
validate models before execution, initialize OpenCode forks before their first
prompt, and record the effective selection on every invocation.

## 2. Normative Terms

- **Model ref:** Immutable `{ provider, model }` strings owned by Seqlane.
- **Model selection:** A model ref plus optional `ReasoningEffort`.
- **Effective selection:** The selection after session inheritance and executor
  default resolution.
- **New session:** An isolated session or a native branch/child session.
- **Continuation:** A task that reuses an existing logical session.
- **Pinned session:** A logical session with an immutable effective selection.
- **Available model:** A normalized executor-owned provider/model entry that can
  be used by the selected adapter configuration.

## 3. Invariants

- Core and Plans contain no executor-native model objects.
- OpenAI and Anthropic helpers accept only generated IDs; generic `model()`
  accepts unknown provider/model strings with a first-slash split.
- Reasoning is optional and limited to `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, and `max`.
- Omitted selection on a new session resolves to and records the executor
  default.
- Model selection is nested under `session`; task definitions do not carry
  model or reasoning fields.
- `isolated` and `branch` may contain a selection; `reuse` cannot contain one.
- A continuation inherits its pinned selection.
- An equal explicit continuation selection is valid; a different one fails
  before execution and recommends a branch or isolated session.
- A branch inherits its parent selection unless explicitly changed, then pins
  the new selection.
- Distinct child sessions can use distinct selections.
- No model fallback occurs after validation.
- Availability failures occur before the first invocation starts.
- OpenCode fork configuration completes before the first fork prompt.
- Every invocation exposes the effective provider, model, and optional
  reasoning in Seqlane-owned observability data.

## 4. Public and Plan Contracts

`@seqlane/core/models` exports:

```ts
type ModelRef<Provider extends string = string, Model extends string = string> =
  Readonly<{ provider: Provider; model: Model }>;

type ReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ModelSelection = Readonly<{
  model: ModelRef;
  reasoning?: ReasoningEffort;
}>;
```

Session helpers expose model selection using the nested authoring shape
`isolated({ model: openai("..."), reasoning: "high" })` and
`branch(checkpoint, { model: openai("..."), reasoning: "high" })`.
`reuse(checkpoint)` has no selection argument. Builder/Plan code preserves the
same nested `ModelSelection` shape.

Task Plan nodes serialize only the normalized model selection. Omitted model
is distinct from an explicit model until session resolution. Existing Plans
without model fields remain valid and resolve through the executor default.

## 5. Runtime and Adapter Contracts

Extend the private executor abstraction with normalized capabilities:

- list available models for the active runtime configuration;
- resolve the active default model;
- configure a new session with a selected model/reasoning before its first
  prompt; and
- report adapter name and useful alternatives on unavailable-model errors.

The core contract does not expose OpenCode response types. OpenCode maps its
provider catalog, default, model request, and reasoning request into these
capabilities. A future adapter can implement the same capability without
changing Plans.

## 6. Validation and Lifecycle

Plan validation resolves declarations that are statically knowable and rejects
conflicting continuation selections. Runtime preflight resolves defaults,
checks all distinct required models, and records the effective selection in the
execution context before scheduling an invocation.

Session resolution reuses ADR-021 checkpoint materialization. It carries the
effective selection with each private resolved session and copies it to reused
or inherited branch sessions. A changed branch selection is applied only while
the branch session is initialized.

## 7. Observability

Invocation metrics/events include a Seqlane-owned effective model selection.
Inherited selections are emitted explicitly. Native provider payloads remain
private and are not serialized into Plans, runner IPC, or canonical events.

## 8. Compatibility and Exclusions

Model fields are additive. Legacy task definitions and Plans omit model data
and use executor defaults. This change does not add Codex support, automatic
fallback, pricing, credentials, provider execution, or model profile policy.

## 9. Verification Gate

Each story must pass its mapped scoped tests, then the full gate:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
git diff --check
```
