# Authoring workflows

Use the Seqlane workflow DSL to define a typed graph of software-engineering
work. A workflow declares input, output, tasks, and execution policy.

Use `createFlow` to start a workflow. Add tasks with `.task()`. Select the
final result with `.output()`. Call `.define()` to create the workflow.

```ts
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const input = z.object({ pullRequest: z.number().int() });
const output = z.object({ approved: z.boolean() });

const inspect = defineTask({
  id: "inspect",
  input,
  output,
  execute: async ({ input }) => ({ approved: input.pullRequest > 0 }),
});

export default createFlow({ id: "review", input, output })
  .task("inspect", inspect, ({ input }) => input)
  .output(({ tasks }) => tasks.inspect.output)
  .define();
```

The input and output schemas define the workflow boundary. Task bindings define
data flow. Session and workspace options define execution policy.

Read [Tasks and data flow](/authoring-workflows/tasks-and-data-flow) for task
definitions and typed bindings.
