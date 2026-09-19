# Workflow composition

Use a workflow as a `.task()` target to compose reusable workflow units. The
child workflow has its own input and output schema. The parent receives a typed
output handle for each child invocation.

```ts
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const pullRequestInput = z.object({ pullRequest: z.number().int() });
const analysisOutput = z.object({ summary: z.string() });

const analyze = defineTask({
  id: "analyze",
  input: pullRequestInput,
  output: analysisOutput,
  execute: async ({ input }) => ({
    summary: `Analysis for pull request ${input.pullRequest}`,
  }),
});

const analyzePullRequest = createFlow({
  id: "analyze-pull-request",
  input: pullRequestInput,
  output: analysisOutput,
})
  .task("analysis", analyze, ({ input }) => input)
  .output(({ tasks }) => tasks.analysis.output)
  .define();

export default createFlow({
  id: "review-pull-request",
  input: pullRequestInput,
  output: analysisOutput,
})
  .task("analysis", analyzePullRequest, ({ input }) => input)
  .output(({ tasks }) => tasks.analysis.output)
  .define();
```

The parent invokes `analyzePullRequest` as one task target. It can bind child
input from workflow input or an earlier task output. These bindings create the
same automatic dependencies as task bindings.

The child workflow defines its own tasks, sessions, and workspace policies. Set
the child invocation workspace in the parent when needed:

```ts
.task("analysis", analyzePullRequest, ({ input }) => input, {
  workspace: "shared",
})
```

You can invoke one child workflow from multiple parents. This keeps repeated
work typed and independently testable.
