// @test-scope ../compile/compile-plan.ts
// @test-scope ./repeat-execution.ts
import type {
  Plan,
  PlanNode,
  RepeatNode,
  SeqlaneEvent,
  ValueBinding,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  ExecutorError,
  LoopLimitExceededError,
  runCompiledWorkflow,
  startCompiledWorkflow,
} from "../../index.js";
import { EffectCompiler } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "../execution/executor.js";

function task(
  nodeId: string,
  dependsOn: readonly string[],
  input: ValueBinding,
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    executor: "test-executor",
    input,
    dependsOn,
  } as PlanNode;
}

function repeatPlan(maximumIterations: number): Plan {
  const repeatNodeId = "repeat:1";
  const inputNodeId = `${repeatNodeId}:input`;
  const bodyNodeId = `${repeatNodeId}/body:1`;
  const repeat: RepeatNode = {
    type: "repeat",
    nodeId: repeatNodeId,
    input: { passed: false },
    dependsOn: [],
    maximumIterations,
    body: {
      inputNodeId,
      nodes: [
        task(bodyNodeId, [inputNodeId], {
          state: { type: "ref", nodeId: inputNodeId, path: [] },
        }) as Extract<PlanNode, { type: "task" }>,
      ],
      output: { type: "ref", nodeId: bodyNodeId, path: ["output"] },
      until: {
        type: "ref",
        nodeId: bodyNodeId,
        path: ["output", "passed"],
      },
    },
  };

  return {
    workflow: { id: "repeat-workflow" },
    nodes: [repeat],
    output: { type: "ref", nodeId: repeatNodeId, path: ["output"] },
  };
}

function sequentialRepeatPlan(): Plan {
  const repeatNodeId = "repeat:1";
  const inputNodeId = `${repeatNodeId}:input`;
  const prepareNodeId = `${repeatNodeId}/prepare:1`;
  const verifyNodeId = `${repeatNodeId}/verify:1`;
  const repeat: RepeatNode = {
    type: "repeat",
    nodeId: repeatNodeId,
    input: { passed: false },
    dependsOn: [],
    maximumIterations: 1,
    body: {
      inputNodeId,
      nodes: [
        task(prepareNodeId, [inputNodeId], {
          state: { type: "ref", nodeId: inputNodeId, path: [] },
        }) as Extract<PlanNode, { type: "task" }>,
        task(verifyNodeId, [prepareNodeId], {
          state: { type: "ref", nodeId: prepareNodeId, path: ["output"] },
        }) as Extract<PlanNode, { type: "task" }>,
      ],
      output: { type: "ref", nodeId: verifyNodeId, path: ["output"] },
      until: {
        type: "ref",
        nodeId: verifyNodeId,
        path: ["output", "passed"],
      },
    },
  };

  return {
    workflow: { id: "sequential-repeat-workflow" },
    nodes: [repeat],
    output: { type: "ref", nodeId: repeatNodeId, path: ["output"] },
  };
}

function compile(
  source: Plan,
  executor: (request: ExecutorRequest) => Promise<unknown>,
  events?: { emit(event: SeqlaneEvent): void },
) {
  return new EffectCompiler().compileWorkflow(source, {
    createInvocationId: (nodeId) => nodeId,
    executors: new Map([["test-executor", { execute: executor }]]),
    events,
  });
}

describe("conditioned repeat execution", () => {
  it("returns after the first successful iteration", async () => {
    let executions = 0;
    const compiled = compile(repeatPlan(3), async () => {
      executions += 1;
      return { passed: true };
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toEqual({
      status: "succeeded",
      result: { passed: true },
    });
    expect(executions).toBe(1);
  });

  it("runs sequentially until the final permitted iteration succeeds", async () => {
    const inputs: unknown[] = [];
    const compiled = compile(repeatPlan(3), async ({ input }) => {
      inputs.push(input);
      return { passed: inputs.length === 3 };
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { passed: true },
    });
    expect(inputs).toEqual([
      { state: { passed: false } },
      { state: { passed: false } },
      { state: { passed: false } },
    ]);
  });

  it("resolves one executor session for each repeat-body task invocation", async () => {
    const resolvedInvocations: string[] = [];
    const bodyTaskId = "repeat:1/body:1";
    let executions = 0;
    const taskSchema = { parse: (value: unknown) => value };
    const compiled = new EffectCompiler().compileWorkflow(repeatPlan(2), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        [
          "test-executor",
          { execute: async () => ({ source: "unresolved executor" }) },
        ],
      ]),
      taskDefinitions: new Map([
        [
          bodyTaskId,
          {
            id: bodyTaskId,
            workspace: "shared",
            input: taskSchema,
            output: taskSchema,
            goal: () => "complete the repeat body",
          },
        ],
      ]),
      sessionResolver: {
        resolve: async ({ invocationId }) => {
          resolvedInvocations.push(invocationId);
          return {
            key: Symbol(invocationId),
            executor: {
              execute: async () => {
                executions += 1;
                return { passed: executions === 2 };
              },
            },
          };
        },
      },
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(resolvedInvocations).toEqual([
      "repeat:1/body:1:iteration:1",
      "repeat:1/body:1:iteration:2",
    ]);
  });

  it("emits loop and per-iteration body invocation events", async () => {
    const events: SeqlaneEvent[] = [];
    let executions = 0;
    const compiled = compile(
      repeatPlan(2),
      async () => {
        executions += 1;
        return { passed: executions === 2 };
      },
      { emit: (event) => events.push(event) },
    );

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { passed: true },
    });

    const created = events.filter(
      (
        event,
      ): event is Extract<SeqlaneEvent, { type: "invocation.created" }> =>
        event.type === "invocation.created",
    );
    const loop = created.find((event) => event.kind === "loop");
    const bodies = created.filter((event) => event.kind === "task");

    expect(loop).toMatchObject({
      planNodeId: "repeat:1",
      taskId: "repeat:1",
      kind: "loop",
      label: "repeat:1",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies).toMatchObject([
      {
        planNodeId: "repeat:1/body:1",
        parentInvocationId: loop?.invocationId,
        iteration: 1,
      },
      {
        planNodeId: "repeat:1/body:1",
        parentInvocationId: loop?.invocationId,
        iteration: 2,
      },
    ]);
    expect(new Set(bodies.map(({ invocationId }) => invocationId)).size).toBe(
      2,
    );
    expect(
      events
        .filter((event) => event.type === "invocation.started")
        .map((event) =>
          event.type === "invocation.started" ? event.iteration : undefined,
        )
        .filter((iteration): iteration is number => iteration !== undefined),
    ).toEqual([1, 2]);
  });

  it("executes body task dependencies sequentially", async () => {
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const compiled = compile(sequentialRepeatPlan(), async (request) => {
      calls.push(request.taskId);
      inputs.push(request.input);
      return request.taskId.endsWith("/prepare:1")
        ? { passed: false, prepared: true }
        : { passed: true };
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { passed: true },
    });
    expect(calls).toEqual(["repeat:1/prepare:1", "repeat:1/verify:1"]);
    expect(inputs).toEqual([
      { state: { passed: false } },
      { state: { passed: false, prepared: true } },
    ]);
  });

  it("releases repeat body values after each iteration while preserving summaries", async () => {
    const events: SeqlaneEvent[] = [];
    let executions = 0;
    const compiled = compile(
      sequentialRepeatPlan(),
      async ({ taskId }) => {
        executions += 1;
        return taskId.endsWith("/prepare:1")
          ? { passed: false, prepared: true }
          : { passed: executions === 2 };
      },
      { emit: (event) => events.push(event) },
    );

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { passed: true },
    });

    expect(compiled.context.results).toEqual(new Map());
    const taskOutputs = events.filter(
      (event): event is Extract<SeqlaneEvent, { type: "invocation.output" }> =>
        event.type === "invocation.output" &&
        event.policy === "persistent" &&
        event.channel === "task" &&
        event.content === "Task completed",
    );
    expect(taskOutputs).toHaveLength(2);
    expect(taskOutputs.every((event) => event.summary !== undefined)).toBe(
      true,
    );
  });

  it("fails with LoopLimitExceededError after the final false condition", async () => {
    let executions = 0;
    const compiled = compile(repeatPlan(2), async () => {
      executions += 1;
      return { passed: false };
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({
      error: {
        category: "RuntimeError",
        nodeId: "repeat:1",
        maximumIterations: 2,
      },
    });
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toBeInstanceOf(LoopLimitExceededError);
    expect(executions).toBe(2);
  });

  it("propagates body task failures without starting another iteration", async () => {
    let executions = 0;
    const compiled = compile(repeatPlan(3), async () => {
      executions += 1;
      throw new Error("body failed");
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toBeInstanceOf(ExecutorError);
    expect(executions).toBe(1);
  });

  it("cancels an active body task and does not start another iteration", async () => {
    let executions = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const compiled = compile(repeatPlan(3), async ({ signal }) => {
      executions += 1;
      markStarted();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("body aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      return { passed: false };
    });

    const activeRun = startCompiledWorkflow(compiled);
    await started;
    await activeRun.cancel();

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(executions).toBe(1);
  });
});
