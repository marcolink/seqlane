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

const summarizeReadContextTask = defineAgentTask({
  id: "workflow-read-context.summarize",
  input: readContextRetrievalSchema,
  output: ReadContextSchema,
  goal: ({ question, corpus }) =>
    `Answer this exact codebase question from the supplied evidence only: ${question}\n\nEvidence:\n${corpus}`,
  instructions: [
    "Do not propose code changes, implementation plans, or architectural choices.",
    "Do not reproduce large code blocks.",
    "Cite repository-relative source paths and line ranges in evidence.",
    "Return only data matching ReadContextSchema.",
  ],
});

const normalizeReadContextTask = defineTask({
  id: "workflow-read-context.normalize",
  input: z.object({
    retrieval: readContextRetrievalSchema,
    summary: ReadContextSchema,
  }),
  output: ReadContextSchema,
  execute: async ({ input }) => ({
    ...input.summary,
    uncertainties: [
      ...new Set([
        ...input.summary.uncertainties,
        ...input.retrieval.uncertainties,
      ]),
    ].slice(0, 12),
    retrieval: {
      selectedPaths: input.retrieval.selectedPaths,
      excludedPaths: input.retrieval.excludedPaths,
      usedExactSearch: input.retrieval.usedExactSearch,
      usedZvecGrep: input.retrieval.usedZvecGrep,
      usedRipwire: input.retrieval.usedRipwire,
    },
  }),
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
