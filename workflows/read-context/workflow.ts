import {
  createFlow,
  defineAgentTask,
  defineTask,
  isolated,
} from "@seqlane/core";
import { model } from "@seqlane/core/models";
import { z } from "zod";
import {
  formatReadContextSummaryPrompt,
  mergeReadContextUncertainties,
  readContextInputSchema,
  readContextRetrievalSchema,
  ReadContextSchema,
  READ_CONTEXT_SUMMARY_INSTRUCTIONS,
  validateReadContextReferences,
  type ReadContextRequest,
  type ReadContextResult,
} from "./src/index.js";
import { readContextRetrievalWorkflow } from "./tasks/retrieval-workflow.js";

const summarizeReadContextTask = defineAgentTask({
  id: "read-context-summarize",
  input: readContextRetrievalSchema,
  output: ReadContextSchema,
  goal: formatReadContextSummaryPrompt,
  instructions: [...READ_CONTEXT_SUMMARY_INSTRUCTIONS],
});

const normalizeReadContextTask = defineTask({
  id: "read-context-normalize",
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
  id: "read-context",
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
        model: model("openai/gpt-6-luna"),
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

export type ReadContextWorkflowInput = ReadContextRequest;
export type ReadContextWorkflowOutput = ReadContextResult;

export default readContextWorkflow;
