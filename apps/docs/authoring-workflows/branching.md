# Branching

Use `.when(...).task(...).otherwise(...)` to run one of two tasks. The
condition must be a Boolean reference from workflow input or an earlier task.

```ts
import { createFlow } from "@seqlane/core";
import {
  changeClassifier,
  securityReviewTask,
  standardReviewTask,
  workflowInputSchema,
  workflowOutputSchema,
} from "./tasks";

export default createFlow({
  id: "review-change",
  input: workflowInputSchema,
  output: workflowOutputSchema,
})
  .task("classification", changeClassifier, ({ input }) => input)
  .when(({ tasks }) => tasks.classification.output.needsSecurityReview)
  .task("review", securityReviewTask, ({ input }) => ({ change: input.change }))
  .otherwise(standardReviewTask, ({ input }) => ({ change: input.change }))
  .output(({ tasks }) => tasks.review.output)
  .define();
```

`classification` decides the route. A value of `true` runs
`securityReviewTask`; `false` runs `standardReviewTask`. Only the selected task
starts. Both paths write to the `review` handle.

The two tasks can have different output schemas. `tasks.review.output` has the
union of their output types. The workflow output schema validates the final
value. If a later task uses `review`, its input must accept that union or a
value selected from it.

The false path is required. A failed or cancelled selected task does not run
the other task as a fallback. Each path can also run a child workflow. Task
paths accept the ordinary session, workspace, and output validation options;
child workflows accept workspace options.
