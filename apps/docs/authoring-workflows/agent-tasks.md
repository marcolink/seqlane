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

## Prompt caching and task input

Prompt caching can reduce input processing when requests reuse the same prompt
prefix. The cache uses the prompt sent by the adapter, not the `defineAgentTask`
fields directly. Seqlane does not expose a cache key or cache breakpoint for an
agent task, so its field layout cannot guarantee a cache hit.

To make reuse more likely, keep shared content stable and put changing data at
the end of the goal:

- Put task rules in `instructions`.
- Keep `references` and their contents stable across calls.
- Put only run-specific facts in `goal(input)`. Keep them compact and relevant.
- Keep the model and tool definitions stable. Reuse a session when later turns
  can reuse its conversation history.

For example, keep the review rules and rubric fixed. Pass each change's ID and
compact evidence through the goal. Do not repeat the rules there or include a
full patch when a short evidence list is enough.

**OpenAI** prompt caching requires at least 1,024 visible input tokens on GPT-5.6
and later models. Do not add filler to reach this size. A one-off task may not
reuse its cached prefix. See the
[**OpenAI** prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

**Claude Code** also reuses prompt prefixes. It manages caching automatically,
while direct Claude API requests use `cache_control` settings. Cache thresholds,
lifetime, and pricing differ by model and platform. See the
[**Claude Code** cost guidance](https://code.claude.com/docs/en/costs) and the
[Claude API prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

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
