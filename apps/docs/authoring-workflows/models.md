# Model selection

Model selection belongs to a session. Set a model where a task starts an
isolated or branched session. A workflow-level model is only the default for
new sessions.

::: info Session rule

Select a model with `isolated()` or `branch()`. A reused session always
inherits its source model and cannot select another model.

:::

## Set a model for a task session

Set the model in the task invocation with `isolated()` or `branch()`:

```ts
import { isolated } from "@seqlane/core";
import { openai } from "@seqlane/core/models";

.task("investigate", investigate, ({ input }) => input, {
  session: isolated({
    model: openai("gpt-5.6-luna"),
    reasoning: "high",
  }),
})
```

## Set a workflow default

Add `model` to `createFlow` to set the default for new agent sessions. It has
a provider, model, and optional reasoning effort.

```ts
import { openai } from "@seqlane/core/models";

const workflow = createFlow({
  id: "review",
  input,
  output,
  model: {
    model: openai("gpt-5.6-luna"),
    reasoning: "high",
  },
});
```

## Model catalog

Seqlane provides catalog helpers for known OpenAI and Anthropic model IDs. They
provide TypeScript autocomplete and type checks.

The model contract stores provider and model strings. The catalog is not a
runtime allowlist. Use `model()` for any provider and model ID:

::: info Agent configuration

Available models and their names depend on the selected agent configuration.
Use a model ID that the agent configuration recognizes.

:::

```ts
import { model } from "@seqlane/core/models";

const previewModel = model("acme/preview-model");
```

The selected adapter must support the model. A catalog entry does not mean that
an adapter can use it.

## Structured output

An agent result must match the task output schema. Seqlane validates each
result before the task completes.

OpenCode can use native structured output when the runtime and model support
it. Otherwise, it can request JSON in the prompt and validate the result. This
fallback can repair malformed output, but it is less reliable than native
structured output.

## Session model policy

An isolated session can select a model. A branched session can select a model
or inherit the source model. A reused session always inherits the source model.

::: info Convention

Keep one model for one session. This is a Seqlane convention, not behavior
enforced by the agent or harness. A model change in one session degrades
performance.

:::

The adapter must honor the effective selection. Seqlane stops the run if the
adapter reports a different selection for that session.
