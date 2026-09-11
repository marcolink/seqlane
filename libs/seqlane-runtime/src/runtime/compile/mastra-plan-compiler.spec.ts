// @test-scope ./mastra-plan-compiler.ts
// @test-scope ./compile-plan.ts
// @test-scope ../validation/plan-validation.ts
// @test-scope ../plan/plan-ordering.ts
// @test-scope ../plan/binding-resolution.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Plan,
  PlanNode,
  TaskDefinition,
  ValidationSource,
} from "@seqlane/core";
import type { ObservabilityContext } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileBuiltWorkflowToMastra,
  compilePlanToMastra,
} from "./mastra-plan-compiler.js";
import { createMastraRuntime } from "../mastra/mastra-runtime.js";

const taskInput = z.object({ value: z.number() });
const taskOutput = z.object({ value: z.number() });

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  input: PlanNode["input"] = {},
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input,
    dependsOn,
  };
}

function plan(nodes: readonly PlanNode[], output: Plan["output"]): Plan {
  return { workflow: { id: "mastra-plan-compiler" }, nodes, output };
}

function definitions(...ids: string[]): ReadonlyMap<string, TaskDefinition> {
  return new Map(
    ids.map((id) => [
      id,
      {
        id,
        input: id === "source" ? z.object({}) : taskInput,
        output: taskOutput,
        execute: async ({ input, context }) =>
          context.runAgent({
            goal: `process ${(input as { value: number }).value}`,
          }),
      },
    ]),
  );
}

function validationCheck(
  nodeId: string,
  source: ValidationSource,
): Extract<PlanNode, { type: "validation.check" }> {
  return {
    type: "validation.check",
    nodeId,
    source,
    input: {},
    dependsOn: [],
  };
}

describe("Mastra Plan compiler", () => {
  it("creates deterministic inspectable steps and preserves the dependency graph", () => {
    const source = plan(
      [
        task("result", ["left", "right"]),
        task("right", ["start"], {
          value: { type: "ref", nodeId: "start", path: ["output", "value"] },
        }),
        task("start"),
        task("left", ["start"], {
          value: { type: "ref", nodeId: "start", path: ["output", "value"] },
        }),
      ],
      { type: "ref", nodeId: "result", path: ["output"] },
    );
    const options = {
      taskDefinitions: definitions("start", "left", "right", "result"),
      workflow: { input: z.object({}), output: taskOutput },
      executeInvocation: async ({ input }: { input: unknown }) => input,
    };

    const first = compilePlanToMastra(source, options);
    const second = compilePlanToMastra(source, options);

    expect(first.invocationSteps.map(({ nodeId }) => nodeId)).toEqual([
      "start",
      "left",
      "right",
      "result",
    ]);
    expect(first.workflow.serializedStepGraph).toEqual(
      second.workflow.serializedStepGraph,
    );
    expect(first.workflow.serializedStepGraph).toEqual([
      {
        type: "step",
        step: expect.objectContaining({ id: "start" }),
      },
      {
        type: "parallel",
        steps: [
          { type: "step", step: expect.objectContaining({ id: "left" }) },
          { type: "step", step: expect.objectContaining({ id: "right" }) },
        ],
      },
      {
        type: "step",
        step: expect.objectContaining({ id: "result" }),
      },
      {
        type: "step",
        step: expect.objectContaining({ id: "__seqlane_result" }),
      },
    ]);
    expect(first.workflow.steps.start?.metadata).toEqual(
      expect.objectContaining({
        seqlane: expect.objectContaining({
          planNodeId: "start",
          dependsOn: [],
        }),
      }),
    );
  });

  it("resolves typed bindings and returns the declared workflow output", async () => {
    const sourceNode = task("source");
    const finalNode = task("final", ["source"], {
      value: { type: "ref", nodeId: "source", path: ["output", "value"] },
    });
    const source = plan([sourceNode, finalNode], {
      type: "ref",
      nodeId: "final",
      path: ["output"],
    });
    const invocations: Array<{ nodeId: string; input: unknown }> = [];
    const compiled = compileBuiltWorkflowToMastra(
      {
        plan: source,
        workflow: { input: z.object({}), output: taskOutput },
        taskDefinitions: definitions("source", "final"),
      },
      {
        executeInvocation: async ({ node, input }) => {
          invocations.push({ nodeId: node.nodeId, input });
          const value =
            node.nodeId === "source" ? 0 : taskInput.parse(input).value;
          return { value: value + 1 };
        },
      },
    );
    const runtime = createMastraRuntime([
      { key: compiled.key, workflow: compiled.workflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: compiled.key,
        input: {},
        workId: "work-1",
        runId: "run-1",
      }),
    ).resolves.toEqual({ status: "succeeded", result: { value: 2 } });
    expect(invocations).toEqual([
      { nodeId: "source", input: {} },
      { nodeId: "final", input: { value: 1 } },
    ]);
  });

  it("passes Work, Run, and Invocation identity to Mastra steps", async () => {
    const source = plan([task("source")], {
      type: "ref",
      nodeId: "source",
      path: ["output"],
    });
    const identities: unknown[] = [];
    const compiled = compilePlanToMastra(source, {
      taskDefinitions: definitions("source"),
      workflow: { input: z.object({}), output: taskOutput },
      workId: "work-identity",
      runId: "run-identity",
      createInvocationId: (nodeId) => `invocation:${nodeId}`,
      executeInvocation: async (context) => {
        identities.push({
          workId: context.workId,
          runId: context.runId,
          invocationId: context.invocationId,
          workflowId: context.workflowId,
        });
        return { value: 1 };
      },
    });

    await expect(
      (
        await compiled.workflow.createRun({
          runId: "run-identity",
          resourceId: "work-identity",
        })
      ).start({ inputData: {} }),
    ).resolves.toMatchObject({ status: "success" });
    expect(identities).toEqual([
      {
        workId: "work-identity",
        runId: "run-identity",
        invocationId: "invocation:source",
        workflowId: "mastra-plan-compiler",
      },
    ]);
  });

  it("preserves all flattened Mastra observability fields for an invocation", async () => {
    const source = plan([task("source")], {
      type: "ref",
      nodeId: "source",
      path: ["output"],
    });
    const observability = {
      tracing: { tracing: "legacy" },
      tracingContext: { tracing: "context" },
      loggerVNext: { logger: "logger" },
      metrics: { metrics: "metrics" },
    } as unknown as Partial<ObservabilityContext>;
    const received: Partial<ObservabilityContext>[] = [];
    const compiled = compilePlanToMastra(source, {
      taskDefinitions: definitions("source"),
      workflow: { input: z.object({}), output: taskOutput },
      executeInvocation: async (context) => {
        received.push(context.observability);
        return { value: 1 };
      },
    });

    const step = compiled.workflow.steps.source;
    if (step === undefined) throw new Error("source step is missing");
    const executeStep = async (
      stepObservability: Partial<ObservabilityContext>,
    ): Promise<void> => {
      await step.execute({
        getInitData: () => ({}),
        getStepResult: () => undefined,
        runId: "run-observability",
        resourceId: "work-observability",
        workflowId: "mastra-plan-compiler",
        abortSignal: new AbortController().signal,
        requestContext: {},
        ...stepObservability,
      } as never);
    };

    await executeStep(observability);
    const nextObservability = {
      ...observability,
      tracing: { tracing: "next" },
    } as Partial<ObservabilityContext>;
    await executeStep(nextObservability);

    expect(received).toEqual([observability, nextObservability]);
    expect(received[0]?.tracing).toBe(observability.tracing);
    expect(received[0]?.tracingContext).toBe(observability.tracingContext);
    expect(received[0]?.loggerVNext).toBe(observability.loggerVNext);
    expect(received[0]?.metrics).toBe(observability.metrics);
    expect(received[1]?.tracing).toBe(nextObservability.tracing);
    expect(received[1]?.tracing).not.toBe(received[0]?.tracing);
  });

  it("rejects malformed plans before creating a Mastra workflow", () => {
    const cyclic = plan([task("a", ["b"]), task("b", ["a"])], {
      type: "ref",
      nodeId: "a",
      path: ["output"],
    });

    expect(() => compilePlanToMastra(cyclic)).toThrow(/cycle/i);
  });

  it.each([
    [
      "legacy executor metadata",
      plan([{ ...task("source"), executor: "legacy" } as unknown as PlanNode], {
        type: "ref",
        nodeId: "source",
        path: ["output"],
      }),
    ],
    [
      "executable binding fields",
      plan(
        [
          {
            ...task("source"),
            input: { execute: async () => undefined } as never,
          },
        ],
        { type: "ref", nodeId: "source", path: ["output"] },
      ),
    ],
  ])(
    "rejects non-canonical Plan %s before Mastra workflow creation",
    (_description, source) => {
      expect(() => compilePlanToMastra(source)).toThrow(/schema/i);
    },
  );

  it("rejects a task registry whose key does not match its definition ID", () => {
    const definition: TaskDefinition = {
      id: "different-id",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => ({}),
    };

    expect(() =>
      compilePlanToMastra(
        plan([task("source")], {
          type: "ref",
          nodeId: "source",
          path: ["output"],
        }),
        { taskDefinitions: new Map([["source", definition]]) },
      ),
    ).toThrow(/registry keys must match task definition IDs/i);
  });

  it.each(["__seqlane_input", "__seqlane_result"])(
    "rejects reserved node ID %s before creating a Mastra workflow",
    (nodeId) => {
      expect(() =>
        compilePlanToMastra(
          plan([task(nodeId)], {
            type: "ref",
            nodeId,
            path: ["output"],
          }),
        ),
      ).toThrow(`reserved node ID "${nodeId}"`);
    },
  );

  it("rejects a missing mechanical validator before creating a Mastra workflow", () => {
    const check = validationCheck("check", {
      type: "mechanical",
      validatorId: "missing-validator",
    });

    expect(() =>
      compilePlanToMastra(
        plan([check], {
          type: "ref",
          nodeId: check.nodeId,
          path: ["output"],
        }),
      ),
    ).toThrow('No validator "missing-validator" is registered');
  });

  it("rejects a missing evaluator task before creating a Mastra workflow", () => {
    const check = validationCheck("check", {
      type: "task",
      taskId: "missing-evaluator",
      workspace: "shared",
    });

    expect(() =>
      compilePlanToMastra(
        plan([check], {
          type: "ref",
          nodeId: check.nodeId,
          path: ["output"],
        }),
      ),
    ).toThrow(
      'No evaluator task definition registered for "missing-evaluator"',
    );
  });

  it("rejects repeat nodes before creating a Mastra workflow", () => {
    const repeatNode: Extract<PlanNode, { type: "repeat" }> = {
      type: "repeat",
      nodeId: "repeat:1",
      input: { passed: false },
      dependsOn: [],
      maximumIterations: 2,
      body: {
        inputNodeId: "repeat:1:input",
        nodes: [
          task("repeat:1/body:1", ["repeat:1:input"], {
            type: "ref",
            nodeId: "repeat:1:input",
            path: [],
          }) as Extract<PlanNode, { type: "task" }>,
        ],
        output: {
          type: "ref",
          nodeId: "repeat:1/body:1",
          path: ["output"],
        },
        until: {
          type: "ref",
          nodeId: "repeat:1/body:1",
          path: ["output", "passed"],
        },
      },
    };

    expect(() =>
      compilePlanToMastra(
        plan([repeatNode], {
          type: "ref",
          nodeId: "repeat:1",
          path: ["output"],
        }),
      ),
    ).toThrow('Mastra Plan compiler does not support repeat node "repeat:1"');
  });

  it("normalizes typed input failures through Mastra's workflow result", async () => {
    const source = plan([task("source")], {
      type: "ref",
      nodeId: "source",
      path: ["output"],
    });
    const compiled = compilePlanToMastra(source, {
      taskDefinitions: new Map([
        [
          "source",
          {
            id: "source",
            input: taskInput,
            output: taskOutput,
            execute: async ({ context }) =>
              context.runAgent({ goal: "source" }),
          },
        ],
      ]),
      workflow: { input: z.object({}), output: taskOutput },
      executeInvocation: async ({ input }) => input,
    });
    const result = await (
      await compiled.workflow.createRun({ runId: "malformed-run" })
    ).start({ inputData: {} });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toMatch(/value/i);
    }
  });

  it("keeps Mastra imports out of core Plan source", () => {
    const planTypes = readFileSync(
      fileURLToPath(
        new URL("../../../../seqlane-core/src/plan-types.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(planTypes).not.toContain("@mastra/");
  });
});
