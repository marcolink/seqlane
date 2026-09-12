import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const inputSchema = z.object({ fail: z.boolean() });
const outputSchema = z.object({
  value: z.string(),
  runId: z.string(),
  workId: z.string(),
});

const fixtureStep = createStep({
  id: "mastra-runtime-spine-fixture-step",
  inputSchema,
  outputSchema,
  execute: async ({ inputData, runId, resourceId }) => {
    if (inputData.fail) {
      throw new Error("Mastra runtime spine fixture failure");
    }

    return {
      value: "Mastra runtime spine fixture succeeded",
      runId,
      workId: resourceId ?? "",
    };
  },
});

export const mastraRuntimeSpineWorkflow = createWorkflow({
  id: "mastra-runtime-spine-fixture",
  description: "Runs the Mastra runtime spine fixture.",
  inputSchema,
  outputSchema,
})
  .then(fixtureStep)
  .commit();
