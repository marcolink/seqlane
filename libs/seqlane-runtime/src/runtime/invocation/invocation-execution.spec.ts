import type {
  Plan,
  PlanNode,
  SeqlaneEvent,
  TaskDefinition,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCompiledWorkflow } from "../../index.js";
import { PlanCompiler } from "../compile/compile-plan.js";
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
  const taskDefinitions = new Map<string, TaskDefinition>();
  for (const node of source.nodes) {
    if (node.type !== "task") continue;
    const schema = z.unknown();
    taskDefinitions.set(node.taskId, {
      id: node.taskId,
      input: schema,
      output: schema,
      execute: async ({ context }) => context.runAgent({ goal: node.taskId }),
    });
  }
  return new PlanCompiler().compileWorkflow(source, {
    workId: "test-work",
    runId: "run-1",
    createInvocationId: (nodeId) => nodeId,
    executors: new Map([["test-executor", { execute: executor }]]),
    taskDefinitions,
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
});
