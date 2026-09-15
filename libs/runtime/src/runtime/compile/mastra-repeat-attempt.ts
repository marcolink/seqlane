import { createStep } from "@mastra/core/workflows";
import type { Step } from "@mastra/core/workflows";
import type { PlanNode } from "@seqlane/core";
import { z } from "zod";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";
import { executeRepeatAttempt } from "./mastra-repeat-attempt-runtime.js";

export function buildRepeatAttemptStep(
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  invocationId: string,
  dependencies: RepeatCompilerDependencies,
): Step {
  return createStep({
    id: `${node.nodeId}:attempt:mastra`,
    description: `Execute Seqlane repeat attempt ${node.nodeId}`,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: async ({
      inputData,
      state,
      setState,
      workflowId,
      runId,
      requestContext,
      abortSignal,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
    }) =>
      executeRepeatAttempt({
        inputData,
        state,
        setState,
        workflowId,
        runId,
        requestContext,
        abortSignal,
        observability: { tracing, tracingContext, loggerVNext, metrics },
        node,
        invocationId,
        compilerOptions: options,
        dependencies,
      }),
  });
}
