// @test-scope ./invocation-execution.ts
import type {
  Plan,
  PlanNode,
  SeqlaneEvent,
  TaskDefinition,
} from "@seqlane/core";
import type { InteractionEventInput } from "@seqlane/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCompiledWorkflow } from "../execution/workflow-run.test-support.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { CompileWorkflowOptions } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "../execution/executor.js";

function task(nodeId: string): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input: {},
    dependsOn: [],
  } as PlanNode;
}

function compile(
  source: Plan,
  executor: (request: ExecutorRequest) => Promise<unknown>,
  events: SeqlaneEvent[],
  emitAsync?: (event: SeqlaneEvent | InteractionEventInput) => Promise<void>,
  requestUserInput?: CompileWorkflowOptions["requestUserInput"],
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
    requestUserInput,
    events: {
      emit: (event) => events.push(event),
      ...(emitAsync === undefined ? {} : { emitAsync }),
    },
  });
}

describe("task invocation events", () => {
  it("routes a task's agent input request through the invocation to its executor", async () => {
    const events: SeqlaneEvent[] = [];
    const question = {
      questions: [{ id: "note", prompt: "Note?", allowFreeText: true }],
    };
    const answer = {
      status: "answered" as const,
      answers: { note: "from user" },
    };
    const requestUserInput = vi.fn(async () => answer);
    const compiled = compile(
      {
        workflow: { id: "input-test" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async (request) => {
        if (request.requestUserInput === undefined)
          throw new Error("Missing input callback at executor boundary");
        return request.requestUserInput(question, request.signal);
      },
      events,
      undefined,
      requestUserInput,
    );
    await runCompiledWorkflow(compiled);
    expect(requestUserInput).toHaveBeenCalledWith(
      "task:1",
      "task:1",
      question,
      expect.any(AbortSignal),
    );
    expect(
      events.find((event) => event.type === "invocation.result"),
    ).toMatchObject({ result: { state: "present", value: answer } });
  });
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

  it("waits for async invocation.started emission before starting executor work", async () => {
    const events: SeqlaneEvent[] = [];
    let startedRequest = false;
    let executorStarted = false;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const compiled = compile(
      {
        workflow: { id: "test-workflow" },
        nodes: [task("task:1")],
        output: { type: "ref", nodeId: "task:1", path: [] },
      },
      async () => {
        executorStarted = true;
        return { value: "output" };
      },
      events,
      async (event) => {
        if (event.type === "invocation.started") {
          startedRequest = true;
          await acknowledgement;
        }
        if (
          event.type !== "interaction.requested" &&
          event.type !== "interaction.response" &&
          event.type !== "interaction.resolved"
        ) {
          events.push(event);
        }
      },
    );

    const running = runCompiledWorkflow(compiled);
    for (let attempt = 0; attempt < 100 && !startedRequest; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startedRequest).toBe(true);
    expect(executorStarted).toBe(false);
    acknowledge();
    await running;
    expect(executorStarted).toBe(true);
  });
});
