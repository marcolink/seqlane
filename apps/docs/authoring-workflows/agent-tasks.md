# Agent tasks

An agent task sends one goal to the adapter selected for that run. Define it
with an ID, input schema, output schema, and goal function.

```ts
import { defineAgentTask } from "@seqlane/core";
import { z } from "zod";

const review = defineAgentTask({
  id: "review",
  input: z.object({ change: z.string() }),
  output: z.object({ summary: z.string(), approved: z.boolean() }),
  goal: ({ change }) => `Review this change: ${change}`,
  timeoutMs: 30_000,
  instructions: ["Report only supported findings."],
  references: ["CONTRIBUTING.md"],
});
```

`goal` receives typed task input and returns the agent request. Optional
`instructions` and `references` add fixed context.

Agent tasks have a two-minute execution limit by default. Set `timeoutMs` to a
positive integer in milliseconds when one task needs a different limit. The
timer begins when the selected adapter starts external agent execution. Workflow
and adapter admission or queue time do not consume this limit.

`defineAgentTask` does not accept an `execute` function. Seqlane creates it and
sends the request through the selected adapter.

## Output and model requirements

The agent result must match the output schema. Seqlane validates it before the
task completes. OpenCode can use native structured output when the runtime and
model support it. Otherwise, it requests JSON in the prompt and validates the
result. The fallback can repair malformed output, but it is less reliable than
native structured output.

Read [Model selection](/authoring-workflows/models) and
[adapter capabilities](/adapters/overview#capabilities) before you select a
model.

## Sessions, workspaces, and interaction

Declare session and workspace policy where you invoke the task in a workflow.
They do not belong in the task definition.

The selected adapter owns permissions. Agent tasks follow the
[execution convention](/cli/run#execution-convention).

## Prompt caching and task input

### Seqlane adapter behavior

Prompt caching can reduce input processing when requests reuse the same prompt
prefix. Each adapter builds the prompt from the task goal, instructions, and
references. Current adapters put the goal before both instructions and
references. `defineAgentTask` has no setting to change this order or set a cache
breakpoint.

If the goal contains changing data, later instructions and references do not
extend the reusable prefix. Keep changing evidence compact. Keep the model and
tool definitions stable across calls. Reuse a session when later turns can use
its conversation history.

These examples show how the prompt order affects caching. They show fields from
a `defineAgentTask` definition.

::: danger Bad example

The changing diff comes before the stable instructions and reference.

```ts
goal: ({ diff }) => `Review this diff:\n${diff}`,
instructions: ["Report only supported findings."],
references: ["docs/review-rubric.md"],
```
:::

::: info Dynamic input

When the task must receive changing data, put it in the goal and keep the
instructions and references fixed. This avoids repeating the data in the
guidance, but the changing goal still means later fields do not extend the
reusable prefix.

```ts
input: z.object({ title: z.string() }),
goal: ({ title }) => `Review ${title}.`,
instructions: [
  "Check against the review rubric.",
  "Report only supported findings.",
],
references: ["docs/review-rubric.md"],
```
:::

::: tip Good example

If the agent can read the diff from its workspace, use a stable goal. Later
workspace reads then do not change the initial prompt prefix.

```ts
goal: () => "Review the latest diff in the current workspace.",
instructions: ["Report only supported findings."],
references: ["docs/review-rubric.md"],
```
:::

Use the second pattern only for tasks where the selected adapter gives the
agent access to the required workspace data. If the task must pass changing
evidence through the goal, current task fields cannot put instructions or
references before it. An adapter change is required to order those fields
differently.

### Provider-specific behavior

The **OpenAI** API requires at least 1,024 visible input tokens for caching on
GPT-5.6 and later models. Do not add filler to reach this size. A one-off task
may not reuse its cached prefix. See the
[**OpenAI** prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

**Claude Code** manages prompt caching automatically. Direct Anthropic API
requests use `cache_control` settings. Cache thresholds, lifetime, and pricing
differ by model and platform. These links describe provider behavior. They do
not mean that Seqlane adapters expose the same cache controls or guarantee hits.
See [**Claude Code** cost guidance](https://code.claude.com/docs/en/costs) and the
[Claude API prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
