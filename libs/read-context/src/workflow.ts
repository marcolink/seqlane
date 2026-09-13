import {
  createFlow,
  defineAgentTask,
  defineTask,
  isolated,
} from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import { z } from "zod";
import {
  readContextInputSchema,
  readContextRetrievalSchema,
  ReadContextSchema,
} from "./index.js";
import { readContextRetrievalWorkflow } from "./retrieval-workflow.js";
import {
  formatReadContextSummaryPrompt,
  mergeReadContextUncertainties,
  READ_CONTEXT_SUMMARY_INSTRUCTIONS,
} from "./summarization-contract.js";
import { validateReadContextReferences } from "./result-validation.js";

const summarizeReadContextTask = defineAgentTask({
  id: "workflow-read-context.summarize",
  input: readContextRetrievalSchema,
  output: ReadContextSchema,
  goal: formatReadContextSummaryPrompt,
  instructions: [...READ_CONTEXT_SUMMARY_INSTRUCTIONS],
});

const normalizeReadContextTask = defineTask({
  id: "workflow-read-context.normalize",
  input: z.object({
    retrieval: readContextRetrievalSchema,
    summary: ReadContextSchema,
  }),
  output: ReadContextSchema,
  execute: async ({ input }) =>
    validateReadContextReferences(
      mergeReadContextUncertainties(input.summary, input.retrieval),
      input.retrieval,
    ),
});

export const readContextWorkflow = createFlow({
  id: "workflow-read-context",
  input: readContextInputSchema,
  output: ReadContextSchema,
})
  .task("retrieve", readContextRetrievalWorkflow, ({ input }) => input, {
    workspace: "shared",
  })
  .task(
    "summarize",
    summarizeReadContextTask,
    ({ tasks }) => tasks.retrieve.output,
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "medium",
      }),
    },
  )
  .task(
    "normalize",
    normalizeReadContextTask,
    ({ tasks }) => ({
      retrieval: tasks.retrieve.output,
      summary: tasks.summarize.output,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.normalize.output)
  .define();

export type ReadContextWorkflowInput = z.input<typeof readContextInputSchema>;
export type ReadContextWorkflowOutput = z.output<typeof ReadContextSchema>;

export default readContextWorkflow;
