// @test-scope ./mastra-repeat-attempt-runtime.ts

import type { PlanNode } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";
import { executeRepeatAttempt } from "./mastra-repeat-attempt-runtime.js";
import {
  MAX_REPEAT_WORKFLOW_STATE_BYTES,
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
      const current =
        typeof input === "number" ? input : (input as { value: number }).value;
      const value = current + 1;
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
      currentInput: { kind: "initial" },
      workflowInput: { kind: "inline", value: { seed: true } },
      dependencyResults: [
        ["__proto__", { kind: "inline", value: { safe: true } }],
      ],
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
      kind: "inline",
      value: { safe: true },
    });
  });

  it("keeps durable state bounded across 1,000 attempts", async () => {
    const executeInvocation = vi.fn(async () => ({ done: false }));
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
    const node = { ...repeatNode, nextInput: undefined };
    const envelope = repeatEnvelopeSchema.parse({
      __seqlaneRepeatEnvelope: true,
      stateRef: { workflowId: "repeat:1:loop", runId: "run:repeat:1" },
      attemptNumber: 1,
      runContext: { workId: "work", runId: "run" },
      repeatExecutions: 0,
    });
    const initialState = repeatWorkflowStateSchema.parse({
      currentInput: { kind: "initial" },
      workflowInput: { kind: "inline", value: {} },
      dependencyResults: [],
    });
    let state: unknown = initialState;
    const setState = async (next: unknown): Promise<void> => {
      state = next;
    };
    let currentEnvelope = envelope;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      currentEnvelope = await executeRepeatAttempt({
        inputData: currentEnvelope,
        state,
        setState,
        workflowId: "repeat:1:loop",
        runId: "run:repeat:1",
        abortSignal: new AbortController().signal,
        observability: {},
        node,
        invocationId: "repeat:1",
        compilerOptions,
        dependencies,
      });
    }

    expect(currentEnvelope.attemptNumber).toBe(1001);
    expect(
      new TextEncoder().encode(JSON.stringify(state)).byteLength,
    ).toBeLessThan(MAX_REPEAT_WORKFLOW_STATE_BYTES);
    await expect(
      executeRepeatAttempt({
        inputData: currentEnvelope,
        state,
        setState,
        workflowId: "repeat:1:loop",
        runId: "run:repeat:1",
        abortSignal: new AbortController().signal,
        observability: {},
        node,
        invocationId: "repeat:1",
        compilerOptions,
        dependencies,
      }),
    ).rejects.toThrow(/repeat-body execution budget of 1000/);
    expect(executeInvocation).toHaveBeenCalledTimes(1000);
  });
});
