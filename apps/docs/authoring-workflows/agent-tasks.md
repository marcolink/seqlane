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
  instructions: ["Report only supported findings."],
  references: ["CONTRIBUTING.md"],
});
```

`goal` receives typed task input and returns the agent request. Optional
`instructions` and `references` add fixed context.

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
