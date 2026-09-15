// @test-scope ./mastra-repeat-attempt-runtime.ts

import type { PlanNode } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";
import { executeRepeatAttempt } from "./mastra-repeat-attempt-runtime.js";
import {
  repeatEnvelopeSchema,
  repeatWorkflowStateSchema,
} from "./mastra-repeat-envelope.js";

const repeatNode: Extract<PlanNode, { type: "repeat" }> = {
  type: "repeat",
  nodeId: "repeat:1",
  input: {},
  dependsOn: [],
  maximumIterations: 3,
  attempt: {
    type: "task",
    taskId: "attempt-task",
    nodeId: "repeat:1:attempt",
    workspace: "shared",
    input: {},
    dependsOn: [],
  },
  until: {
    type: "ref",
    nodeId: "repeat:1:attempt",
    path: ["output", "done"],
  },
  nextInput: {
    type: "ref",
    nodeId: "repeat:1:attempt",
    path: ["output", "value"],
  },
};

describe("Mastra repeat attempt persistence", () => {
  it("reloads JSON state and resumes the next attempt", async () => {
    let executions = 0;
    const executeInvocation = vi.fn(async ({ input }: { input: unknown }) => {
      executions += 1;
      const value = (input as { value: number }).value + 1;
      return { value, done: executions === 2 };
    });
    const compilerOptions: MastraPlanCompilerOptions = {
      executeInvocation,
    };
    const dependencies: RepeatCompilerDependencies = {
      schemaForMastra: () => z.unknown(),
      schemaForNodeInput: () => undefined,
      schemaForNodeOutput: () => undefined,
      resolveStepInput: () => ({ value: 1 }),
      reportFailure: () => {
        throw new Error("unexpected failure");
      },
      invocationIdForNode: () => undefined,
    };
    const initialEnvelope = repeatEnvelopeSchema.parse({
      __seqlaneRepeatEnvelope: true,
      stateRef: { workflowId: "repeat:1:loop", runId: "run:repeat:1" },
      attemptNumber: 1,
      runContext: { workId: "work", runId: "run" },
      repeatExecutions: 0,
    });
    const initialState = repeatWorkflowStateSchema.parse({
      initialInput: { value: 1 },
      currentInput: { value: 1 },
      workflowInput: { seed: true },
      dependencyResults: [["__proto__", { safe: true }]],
    });
    let state: unknown = initialState;
    const setState = async (next: unknown): Promise<void> => {
      state = next;
    };
    const runAttempt = (
      inputData: unknown,
    ): Promise<ReturnType<typeof repeatEnvelopeSchema.parse>> =>
      executeRepeatAttempt({
        inputData,
        state,
        setState,
        workflowId: "repeat:1:loop",
        runId: "run:repeat:1",
        abortSignal: new AbortController().signal,
        observability: {},
        node: repeatNode,
        invocationId: "repeat:1",
        compilerOptions,
        dependencies,
      });

    const nextEnvelope = await runAttempt(initialEnvelope);
    const reloadedEnvelope = JSON.parse(JSON.stringify(nextEnvelope));
    const reloadedState = JSON.parse(JSON.stringify(state));
    state = repeatWorkflowStateSchema.parse(reloadedState);
    const resumedEnvelope = await runAttempt(reloadedEnvelope);

    expect(executeInvocation).toHaveBeenCalledTimes(2);
    expect(executeInvocation.mock.calls[1]?.[0]).toMatchObject({
      input: 2,
    });
    expect(resumedEnvelope.attemptNumber).toBe(3);
    expect(resumedEnvelope.until).toBe(true);
    expect(new Map(reloadedState.dependencyResults).get("__proto__")).toEqual({
      safe: true,
    });
  });
});
