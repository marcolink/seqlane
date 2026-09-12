// @test-scope ../compile/compile-plan.ts
// @test-scope ../execution/model-preflight.ts
// @test-scope ./repeat-execution.ts
import type {
  ModelSelection,
  Plan,
  PlanNode,
  RepeatNode,
  SeqlaneEvent,
  ValueBinding,
  TaskDefinition,
} from "@seqlane/core";
import type { ObservabilityContext } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ExecutorError,
  LoopLimitExceededError,
  RunRepeatLimitExceededError,
  runCompiledWorkflow,
  startCompiledWorkflow,
} from "../../index.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "../execution/executor.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import { executeRepeatNode } from "./repeat-execution.js";

function task(
  nodeId: string,
  dependsOn: readonly string[],
  input: ValueBinding,
  session?: Extract<PlanNode, { type: "task" }>["session"],
): Extract<PlanNode, { type: "task" }> {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    ...(session === undefined ? {} : { session }),
    input,
    dependsOn,
  } as Extract<PlanNode, { type: "task" }>;
}

function repeatPlan(
  maximumIterations: number,
  bodySession?: Extract<PlanNode, { type: "task" }>["session"],
): Plan {
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
        task(
          bodyNodeId,
          [inputNodeId],
          {
            state: { type: "ref", nodeId: inputNodeId, path: [] },
          },
          bodySession,
        ) as Extract<PlanNode, { type: "task" }>,
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

function repeatValidationPlan(): Plan {
  const repeatNodeId = "repeat:1";
  const inputNodeId = `${repeatNodeId}:input`;
  const taskNodeId = `${repeatNodeId}/task:1`;
  const checkNodeId = `${repeatNodeId}/validation.check:1`;
  const gateNodeId = `${repeatNodeId}/validation.gate:1`;
  return {
    workflow: { id: "repeat-validation-workflow" },
    nodes: [
      {
        type: "repeat",
        nodeId: repeatNodeId,
        input: { passed: false },
        dependsOn: [],
        maximumIterations: 1,
        body: {
          inputNodeId,
          nodes: [
            task(taskNodeId, [inputNodeId], {
              state: { type: "ref", nodeId: inputNodeId, path: [] },
            }),
            {
              type: "validation.check",
              nodeId: checkNodeId,
              source: {
                type: "task",
                taskId: "repeat-validator",
                workspace: "shared",
              },
              input: {
                candidate: {
                  type: "ref",
                  nodeId: taskNodeId,
                  path: ["output"],
                },
              },
              dependsOn: [taskNodeId],
            },
            {
              type: "validation.gate",
              nodeId: gateNodeId,
              input: { type: "ref", nodeId: taskNodeId, path: ["output"] },
              checkNodeId,
              policy: "repeat-postcondition",
              dependsOn: [taskNodeId, checkNodeId],
            },
          ],
          output: { type: "ref", nodeId: gateNodeId, path: ["value"] },
          until: {
            type: "ref",
            nodeId: gateNodeId,
            path: ["validation", "success"],
          },
        },
      },
    ],
    output: { type: "ref", nodeId: repeatNodeId, path: ["output"] },
  };
}

function compile(
  source: Plan,
  executor: (request: ExecutorRequest) => Promise<unknown>,
  events?: { emit(event: SeqlaneEvent): void },
  taskDefinitions?: ReadonlyMap<string, TaskDefinition>,
) {
  const definitions = new Map(taskDefinitions);
  const visit = (node: PlanNode): void => {
    if (node.type === "task" && !definitions.has(node.taskId)) {
      const schema = z.unknown();
      definitions.set(node.taskId, {
        id: node.taskId,
        input: schema,
        output: schema,
        execute: async ({ context }) => context.runAgent({ goal: node.taskId }),
      });
    }
    if (node.type === "repeat") {
      for (const bodyNode of node.body.nodes) visit(bodyNode);
    }
  };
  for (const node of source.nodes) visit(node);
  return new PlanCompiler().compileWorkflow(source, {
    createInvocationId: (nodeId) => nodeId,
    executors: new Map([["test-executor", { execute: executor }]]),
    taskDefinitions: definitions,
    events,
  });
}

describe("conditioned repeat execution", () => {
  it("forwards observability through task, validation check, and gate executions", async () => {
    const observed: Array<{ taskId: string; observability: unknown }> = [];
    const events: SeqlaneEvent[] = [];
    const compiled = compile(
      repeatValidationPlan(),
      async (request) => {
        observed.push({
          taskId: request.taskId,
          observability: request.observability,
        });
        return request.taskId === "repeat-validator"
          ? { success: true }
          : { passed: true };
      },
      { emit: (event) => events.push(event) },
      new Map([
        [
          "repeat-validator",
          {
            id: "repeat-validator",
            input: z.unknown(),
            output: z.unknown(),
            execute: async ({ context }) =>
              context.runAgent({ goal: "validate the repeat body" }),
          },
        ],
      ]),
    );
    const repeat = compiled.plan.nodes[0];
    if (repeat?.type !== "repeat") throw new Error("repeat fixture missing");
    const observability = {
      tracingContext: { currentSpan: {} },
    } as unknown as Partial<ObservabilityContext>;

    await expect(
      executeRepeatNode(
        compiled.context,
        repeat,
        new AbortController().signal,
        observability,
      ),
    ).resolves.toEqual({ passed: true });

    expect(observed).toEqual([
      { taskId: "repeat:1/task:1", observability },
      { taskId: "repeat-validator", observability },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "invocation.created" &&
          event.parentInvocationId === "repeat:1" &&
          event.iteration === 1,
      ),
    ).toMatchObject([
      { planNodeId: "repeat:1/task:1", kind: "task" },
      { planNodeId: "repeat:1/validation.check:1", kind: "validation" },
      {
        planNodeId: "repeat:1/validation.gate:1",
        kind: "validation",
        subject: {
          type: "validation-gate",
          planNodeId: "repeat:1/validation.gate:1",
        },
      },
    ]);
  });

  it("forwards one observability context to every repeat-body invocation", async () => {
    const observed: unknown[] = [];
    const compiled = compile(repeatPlan(1), async (request) => {
      observed.push(request.observability);
      return { passed: true };
    });
    const repeat = compiled.plan.nodes[0];
    if (repeat?.type !== "repeat") throw new Error("repeat fixture missing");
    const observability = {
      tracingContext: { currentSpan: {} },
    } as unknown as Partial<ObservabilityContext>;

    await executeRepeatNode(
      compiled.context,
      repeat,
      new AbortController().signal,
      observability,
    );

    expect(observed).toEqual([observability]);
  });

  it("keeps repeat-body tasks behind dynamic workspace admission", async () => {
    let executed = false;
    const compiled = compile(repeatPlan(1), async () => {
      executed = true;
      return { passed: true };
    });
    const externalLease = await compiled.context.workspaceLocks.acquire(
      { key: "seqlane:runtime-workspace" },
      "exclusive",
    );

    const execution = runCompiledWorkflow(compiled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const executedBeforeRelease = executed;

    externalLease.release();
    await expect(execution).resolves.toMatchObject({ status: "succeeded" });
    expect(executedBeforeRelease).toBe(false);
    expect(executed).toBe(true);
  });

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
    const taskSchema = z.unknown();
    const compiled = new PlanCompiler().compileWorkflow(
      repeatPlan(2, { type: "isolated" }),
      {
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
              input: taskSchema,
              output: taskSchema,
              execute: async ({ context }) =>
                context.runAgent({ goal: "complete the repeat body" }),
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
      },
    );

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(resolvedInvocations).toEqual([
      "repeat:1/body:1:iteration:1",
      "repeat:1/body:1:iteration:2",
    ]);
  });

  it("passes preflighted repeat model selections to runtime sessions and completion metrics", async () => {
    const selectedModel: ModelSelection = {
      model: { provider: "openai", model: "gpt-5.6-sol" },
      reasoning: "high",
    };
    const events: SeqlaneEvent[] = [];
    const resolvedSelections: Array<ModelSelection | undefined> = [];
    const bodyTaskId = "repeat:1/body:1";
    const taskSchema = z.unknown();
    const compiled = new PlanCompiler().compileWorkflow(
      repeatPlan(1, { type: "isolated", model: selectedModel }),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          ["test-executor", { execute: async () => ({ passed: false }) }],
        ]),
        taskDefinitions: new Map([
          [
            bodyTaskId,
            {
              id: bodyTaskId,
              input: taskSchema,
              output: taskSchema,
              execute: async ({ context }) =>
                context.runAgent({ goal: "complete the repeat body" }),
            },
          ],
        ]),
        sessionResolver: {
          modelCapabilities: {
            executor: "resolver-executor",
            listModels: async () => [selectedModel.model],
            resolveDefaultModel: async () => selectedModel,
          },
          resolve: async ({ effectiveSelection }) => {
            resolvedSelections.push(effectiveSelection);
            return {
              key: Symbol("repeat-session"),
              executor: {
                execute: async ({ onMetrics }) => {
                  onMetrics?.({ durationMs: 1 });
                  return { passed: true };
                },
              },
            };
          },
        },
        events: { emit: (event) => events.push(event) },
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { passed: true },
    });

    expect(resolvedSelections).toEqual([selectedModel]);
    expect(
      events.find(
        (event) =>
          event.type === "invocation.output" &&
          event.policy === "persistent" &&
          event.invocationId.startsWith(`${bodyTaskId}:iteration:`),
      ),
    ).toMatchObject({ metrics: { modelSelection: selectedModel } });
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
      (event): event is Extract<SeqlaneEvent, { type: "invocation.created" }> =>
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

  it("rejects the 1,001st repeat-body execution across one run", async () => {
    const compiled = compile(repeatPlan(1), async () => ({ passed: true }));
    const repeat = compiled.plan.nodes[0];
    if (repeat?.type !== "repeat") throw new Error("repeat fixture missing");
    compiled.context.repeatBodyExecutions = 1_000;

    await expect(
      executeRepeatNode(compiled.context, repeat, new AbortController().signal),
    ).rejects.toMatchObject({
      maximumExecutions: 1_000,
      attemptedExecution: 1_001,
    });
    await expect(
      executeRepeatNode(compiled.context, repeat, new AbortController().signal),
    ).rejects.toBeInstanceOf(RunRepeatLimitExceededError);
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
