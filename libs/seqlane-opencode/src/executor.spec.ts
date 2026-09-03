import { describe, expect, it } from "vitest";
import { buildWorkflow, defineTask, defineWorkflow } from "@seqlane/core";
import { z } from "zod";
import { createOpenCodeExecutor } from "./executor.js";
import type { OpenCodePrompt, OpenCodeRun } from "./session.js";
import type { ResolvedStructuredOutput } from "./structured-output-strategy.js";

const unsupportedForkCapabilities = {
  checkpoint: async () => ({ sessionId: "fake", messageId: "message-fake" }),
  fork: async (): Promise<OpenCodeRun> => {
    throw new Error("fork is not used by executor tests");
  },
};

function createFakeRun(result: unknown, selection?: ResolvedStructuredOutput) {
  const prompts: OpenCodePrompt[] = [];
  const run: OpenCodeRun = {
    ...unsupportedForkCapabilities,
    ...(selection === undefined
      ? {}
      : { structuredOutput: async () => selection }),
    prompt: async (request) => {
      prompts.push(request);
      return selection?.strategy === "prompt"
        ? { structured: undefined, text: JSON.stringify(result) }
        : { structured: result };
    },
    abort: async () => undefined,
  };
  return { prompts, run };
}

function createFakeRunWithMetrics(result: unknown) {
  const prompts: OpenCodePrompt[] = [];
  const run: OpenCodeRun = {
    ...unsupportedForkCapabilities,
    prompt: async (request) => {
      prompts.push(request);
      return {
        structured: result,
        metrics: {
          durationMs: 1250,
          model: "fake-model",
          provider: "fake-provider",
          cost: 0.0042,
          tokens: {
            total: 42,
            input: 20,
            output: 12,
            reasoning: 8,
            cacheRead: 2,
            cacheWrite: 0,
          },
        },
      };
    },
    abort: async () => undefined,
  };
  return { prompts, run };
}

describe("OpenCode executor", () => {
  it("sends additive task context and returns only structured output", async () => {
    const task = defineTask({
      id: "investigate",
      workspace: "shared",
      input: z.object({ dependency: z.string() }),
      output: z.object({ files: z.array(z.string()) }),
      goal: ({ dependency }) => `Investigate ${dependency}.`,
      instructions: ["Return remediation evidence."],
      references: ["package.json", "pnpm-lock.yaml"],
    });
    const workflow = defineWorkflow({
      id: "executor",
      input: z.object({ dependency: z.string() }),
      output: z.object({ files: z.array(z.string()) }),
      build: ({ input, run }) => run(task, { input }).output,
    });
    const built = buildWorkflow(workflow);
    const fake = createFakeRun(
      { files: ["package.json"] },
      {
        strategy: "prompt",
        retryCount: 2,
        reason: "affected-version",
        version: "1.18.27",
        report: () => undefined,
      },
    );
    const executor = createOpenCodeExecutor(built.taskDefinitions, fake.run);
    const controller = new AbortController();
    const diagnostics: string[] = [];

    await expect(
      executor.execute({
        invocationId: "inv-1",
        taskId: "investigate",
        input: { dependency: "renovate" },
        signal: controller.signal,
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    ).resolves.toEqual({ files: ["package.json"] });

    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]?.text).toContain(
      [
        "Investigate renovate.",
        "Response format: Return only the requested structured output.",
        "Task instruction: Return remediation evidence.",
        "Task reference: package.json",
        "Task reference: pnpm-lock.yaml",
      ].join("\n"),
    );
    expect(fake.prompts[0]?.schema).toMatchObject({
      type: "object",
      properties: { files: { type: "array" } },
    });
    expect(fake.prompts[0]?.signal).toBe(controller.signal);
    expect(diagnostics).toEqual([
      "OpenCode structured output fallback is active for OpenCode 1.18.27: using prompt mode because the native implementation is on the compatibility list. The JSON response is validated and repaired before task completion.",
    ]);
  });

  it("repairs invalid prompt output without executing the task again", async () => {
    const task = defineTask({
      id: "repair-output",
      workspace: "shared",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      goal: ({ value }) => `Process ${value}`,
    });
    const built = buildWorkflow(
      defineWorkflow({
        id: "repair-output-workflow",
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        build: ({ input, run }) => run(task, { input }).output,
      }),
    );
    const prompts: OpenCodePrompt[] = [];
    const run: OpenCodeRun = {
      ...unsupportedForkCapabilities,
      structuredOutput: async () => ({
        strategy: "prompt",
        retryCount: 1,
        reason: "explicit",
      }),
      prompt: async (request) => {
        prompts.push(request);
        return prompts.length === 1
          ? { structured: undefined, text: "not json" }
          : { structured: undefined, text: '{"result":"ok"}' };
      },
      abort: async () => undefined,
    };
    const executor = createOpenCodeExecutor(built.taskDefinitions, run);

    await expect(
      executor.execute({
        invocationId: "inv-repair",
        taskId: "repair-output",
        input: { value: "demo" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ result: "ok" });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.text).toContain("JSON Schema");
    expect(prompts[0]).not.toHaveProperty("tools");
    expect(prompts[1]?.text).toContain("already completed task");
    expect(prompts[1]?.tools).toEqual({ "*": false, StructuredOutput: true });
  });

  it("stops after the configured repair bound", async () => {
    const task = defineTask({
      id: "exhaust-output",
      workspace: "shared",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      goal: () => "Produce a result",
    });
    const built = buildWorkflow(
      defineWorkflow({
        id: "exhaust-output-workflow",
        input: z.object({}),
        output: z.object({ result: z.string() }),
        build: ({ input, run }) => run(task, { input }).output,
      }),
    );
    let promptCount = 0;
    const run: OpenCodeRun = {
      ...unsupportedForkCapabilities,
      structuredOutput: async () => ({
        strategy: "prompt",
        retryCount: 2,
        reason: "explicit",
      }),
      prompt: async () => {
        promptCount += 1;
        return { structured: undefined, text: "not json" };
      },
      abort: async () => undefined,
    };
    const executor = createOpenCodeExecutor(built.taskDefinitions, run);

    await expect(
      executor.execute({
        invocationId: "inv-exhaust",
        taskId: "exhaust-output",
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
      attempts: 3,
      issues: [expect.objectContaining({ kind: "parse" })],
    });
    expect(promptCount).toBe(3);
  });

  it("forwards available response metrics without changing task output", async () => {
    const task = defineTask({
      id: "measure",
      workspace: "shared",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      goal: () => "Measure this",
    });
    const built = buildWorkflow(
      defineWorkflow({
        id: "metrics",
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        build: ({ input, run }) => run(task, { input }).output,
      }),
    );
    const fake = createFakeRunWithMetrics({ result: "ok" });
    let observed: unknown;
    const executor = createOpenCodeExecutor(built.taskDefinitions, fake.run);

    await expect(
      executor.execute({
        invocationId: "inv-1",
        taskId: "measure",
        input: { value: "demo" },
        signal: new AbortController().signal,
        onMetrics: (metrics) => {
          observed = metrics;
        },
      }),
    ).resolves.toEqual({ result: "ok" });

    expect(observed).toEqual({
      durationMs: 1250,
      model: "fake-model",
      provider: "fake-provider",
      cost: 0.0042,
      tokens: {
        total: 42,
        input: 20,
        output: 12,
        reasoning: 8,
        cacheRead: 2,
        cacheWrite: 0,
      },
    });
  });

  it("forwards a background process report from a write task", async () => {
    const task = defineTask({
      id: "format",
      workspace: "exclusive",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      goal: () => "Format the workspace",
    });
    const built = buildWorkflow(
      defineWorkflow({
        id: "background-process",
        input: z.object({}),
        output: z.object({ result: z.string() }),
        build: ({ input, run }) => run(task, { input }).output,
      }),
    );
    const run: OpenCodeRun = {
      ...unsupportedForkCapabilities,
      prompt: async (request) => {
        request.onBackgroundProcess?.({ mutatesWorkspace: true });
        return { structured: { result: "ok" } };
      },
      abort: async () => undefined,
    };
    const executor = createOpenCodeExecutor(built.taskDefinitions, run);
    let reported = false;

    await executor.execute({
      invocationId: "inv-3",
      taskId: "format",
      input: {},
      signal: new AbortController().signal,
      onBackgroundProcess: () => {
        reported = true;
      },
    });

    expect(reported).toBe(true);
  });

  it("forwards an uncertain task termination report", async () => {
    const task = defineTask({
      id: "inspect",
      workspace: "shared",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      goal: () => "Inspect the workspace",
    });
    const built = buildWorkflow(
      defineWorkflow({
        id: "uncertain-termination",
        input: z.object({}),
        output: z.object({ result: z.string() }),
        build: ({ input, run }) => run(task, { input }).output,
      }),
    );
    const run: OpenCodeRun = {
      ...unsupportedForkCapabilities,
      prompt: async (request) => {
        request.onUncertainActivity?.({ reason: "timeout" });
        return { structured: { result: "ok" } };
      },
      abort: async () => undefined,
    };
    const executor = createOpenCodeExecutor(built.taskDefinitions, run);
    const uncertainties: unknown[] = [];

    await executor.execute({
      invocationId: "inv-4",
      taskId: "inspect",
      input: {},
      signal: new AbortController().signal,
      onUncertainActivity: (activity) => uncertainties.push(activity),
    });

    expect(uncertainties).toEqual([{ reason: "timeout" }]);
  });

  it("fails before sending a request when task metadata cannot provide JSON Schema", async () => {
    const fake = createFakeRun({ ok: true });
    const invalidTask = {
      id: "invalid",
      workspace: "shared" as const,
      input: z.object({ value: z.string() }),
      output: { parse: (value: unknown) => value },
      goal: () => "Do work",
    };
    const executor = createOpenCodeExecutor(
      new Map([["invalid", invalidTask]]),
      fake.run,
    );

    await expect(
      executor.execute({
        invocationId: "inv-2",
        taskId: "invalid",
        input: { value: "demo" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("cannot produce JSON Schema");
    expect(fake.prompts).toEqual([]);
  });
});
