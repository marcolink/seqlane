import {
  branch,
  createFlow,
  defineAgentTask,
  isolated,
  reuse,
} from "@seqlane/core";
import { anthropic, openai } from "@seqlane/core/models";
import { z } from "zod";

const inputSchema = z.object({ label: z.string() });
const outputSchema = z.object({ label: z.string() });

export const MODEL_SELECTION_INVOCATIONS = {
  isolated: "model-selection.isolated",
  source: "model-selection.source",
  reuse: "model-selection.reuse",
  branch: "model-selection.branch",
  child: "model-selection.child",
} as const;

export const isolatedModelSelectionTask = defineAgentTask({
  id: MODEL_SELECTION_INVOCATIONS.isolated,
  input: inputSchema,
  output: outputSchema,
  goal: ({ label }) => `Complete the isolated fixture task for ${label}.`,
});

export const sourceModelSelectionTask = defineAgentTask({
  id: MODEL_SELECTION_INVOCATIONS.source,
  input: inputSchema,
  output: outputSchema,
  goal: ({ label }) => `Create the source fixture context for ${label}.`,
});

export const reuseModelSelectionTask = defineAgentTask({
  id: MODEL_SELECTION_INVOCATIONS.reuse,
  input: inputSchema,
  output: outputSchema,
  goal: ({ label }) => `Continue the source fixture context for ${label}.`,
});

export const branchModelSelectionTask = defineAgentTask({
  id: MODEL_SELECTION_INVOCATIONS.branch,
  input: inputSchema,
  output: outputSchema,
  goal: ({ label }) => `Analyze a branched fixture context for ${label}.`,
});

export const childModelSelectionTask = defineAgentTask({
  id: MODEL_SELECTION_INVOCATIONS.child,
  input: inputSchema,
  output: outputSchema,
  goal: ({ label }) => `Complete a child fixture context for ${label}.`,
});

export const modelSelectionWorkflow = createFlow({
  id: "model-selection-sessions",
  input: inputSchema,
  output: z.object({
    isolated: outputSchema,
    source: outputSchema,
    reuse: outputSchema,
    branch: outputSchema,
    child: outputSchema,
  }),
})
  .task("isolated", isolatedModelSelectionTask, ({ input }) => input, {
    workspace: "shared",
    session: isolated({
      model: openai("gpt-5.6-sol"),
      reasoning: "medium",
    }),
  })
  .task("source", sourceModelSelectionTask, ({ input }) => input, {
    workspace: "shared",
    session: isolated({
      model: openai("gpt-5.6-luna"),
      reasoning: "high",
    }),
  })
  .task(
    "reuse",
    reuseModelSelectionTask,
    ({ tasks }) => ({ label: tasks.source.output.label }),
    {
      workspace: "shared",
      session: ({ tasks }) => reuse(tasks.source.session),
    },
  )
  .task("branch", branchModelSelectionTask, ({ input }) => input, {
    workspace: "shared",
    session: ({ tasks }) =>
      branch(tasks.source.session, {
        model: anthropic("claude-sonnet-4-6"),
        reasoning: "low",
      }),
  })
  .task("child", childModelSelectionTask, ({ input }) => input, {
    workspace: "shared",
    session: ({ tasks }) =>
      branch(tasks.source.session, {
        model: openai("gpt-5.6-sol"),
        reasoning: "minimal",
      }),
  })
  .output(({ tasks }) => ({
    isolated: tasks.isolated.output,
    source: tasks.source.output,
    reuse: tasks.reuse.output,
    branch: tasks.branch.output,
    child: tasks.child.output,
  }))
  .define();
