import type { Plan, PlanNode, SeqlaneEvent } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { runCompiledWorkflow, startCompiledWorkflow } from "../../index.js";
import { EffectCompiler } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "../execution/executor.js";

function task(nodeId: string): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    executor: "test-executor",
    input: {},
    dependsOn: [],
  } as PlanNode;
}

function compile(
  source: Plan,
  executor: (request: ExecutorRequest) => Promise<unknown>,
  events: SeqlaneEvent[],
) {
  return new EffectCompiler().compileWorkflow(source, {
    workId: "test-work",
    runId: "run-1",
    createInvocationId: (nodeId) => nodeId,
    executors: new Map([["test-executor", { execute: executor }]]),
    events: { emit: (event) => events.push(event) },
  });
}

describe("task invocation events", () => {
  it("includes effective metrics in persistent output events", async () => {
    const events: SeqlaneEvent[] = [];
    const executorMetrics = {
      durationMs: 1250,
      model: "fake-model",
      provider: "fake-provider",
      cost: 0.0042,
    } as const;
    const modelSelection = {
      model: { provider: "openai", model: "gpt-5.2" },
      reasoning: "high" as const,
    };
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async ({ onMetrics }) => {
        onMetrics?.(executorMetrics);
        return { value: "output" };
      },
      events,
    );
    compiled.context.effectiveModelSelections.set("task:1", modelSelection);

    await runCompiledWorkflow(compiled);

    const expectedMetrics = { ...executorMetrics, modelSelection };
    const result = events.find((event) => event.type === "invocation.result");
    const output = events.find(
      (event) =>
        event.type === "invocation.output" && event.policy === "persistent",
    );

    expect(result).not.toHaveProperty("metrics");
    expect(output).toMatchObject({ metrics: expectedMetrics });
  });

  it("accumulates metrics from structured-output repair attempts", async () => {
    const events: SeqlaneEvent[] = [];
    const firstAttempt = {
      durationMs: 100,
      model: "model-a",
      provider: "provider-a",
      cost: 0.004,
      tokens: {
        total: 10,
        input: 4,
        output: 3,
        reasoning: 2,
        cacheRead: 1,
        cacheWrite: 0,
      },
    } as const;
    const secondAttempt = {
      durationMs: 200,
      model: "model-b",
      provider: "provider-b",
      cost: 0.006,
      tokens: {
        total: 20,
        input: 8,
        output: 6,
        reasoning: 4,
        cacheRead: 2,
        cacheWrite: 0,
      },
    } as const;
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async ({ onMetrics }) => {
        onMetrics?.(firstAttempt);
        onMetrics?.(secondAttempt);
        return { value: "output" };
      },
      events,
    );

    await runCompiledWorkflow(compiled);

    const output = events.find(
      (event) =>
        event.type === "invocation.output" && event.policy === "persistent",
    );
    expect(output).toMatchObject({
      metrics: {
        durationMs: 300,
        cost: 0.01,
        tokens: {
          total: 30,
          input: 12,
          output: 9,
          reasoning: 6,
          cacheRead: 3,
          cacheWrite: 0,
        },
      },
    });
    expect(output).not.toHaveProperty("metrics.model");
    expect(output).not.toHaveProperty("metrics.provider");
  });

  it("emits metrics received before a terminal executor failure", async () => {
    const events: SeqlaneEvent[] = [];
    const metrics = {
      model: "model-a",
      provider: "provider-a",
      cost: 0.004,
      tokens: {
        total: 10,
        input: 4,
        output: 3,
        reasoning: 2,
        cacheRead: 1,
        cacheWrite: 0,
      },
    } as const;
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async ({ onMetrics }) => {
        onMetrics?.(metrics);
        throw new Error("executor failed after response");
      },
      events,
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        invocationId: "task:1",
        metrics,
      }),
    );
  });

  it("does not emit selection-only metrics after a failure", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async () => {
        throw new Error("executor failed before response");
      },
      events,
    );
    compiled.context.effectiveModelSelections.set("task:1", {
      model: { provider: "openai", model: "gpt-5.6" },
      reasoning: "high",
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      events.filter(
        (event) =>
          event.type === "invocation.output" &&
          event.policy === "persistent" &&
          event.metrics !== undefined,
      ),
    ).toEqual([]);
  });

  it("emits metrics received before cancellation", async () => {
    const events: SeqlaneEvent[] = [];
    let markStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const metrics = {
      model: "model-a",
      provider: "provider-a",
      cost: 0.004,
      tokens: {
        total: 10,
        input: 4,
        output: 3,
        reasoning: 2,
        cacheRead: 1,
        cacheWrite: 0,
      },
    } as const;
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async ({ signal, onMetrics }) => {
        onMetrics?.(metrics);
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("executor cancelled"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
      events,
    );

    const activeRun = startCompiledWorkflow(compiled);
    await executorStarted;
    await activeRun.cancel();

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        invocationId: "task:1",
        metrics,
      }),
    );
  });
});
