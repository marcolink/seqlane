// @test-scope ./mastra-runtime.ts
// @test-scope ./mastra-execution.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Plan,
  SeqlaneSchema,
  TaskDefinition,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
} from "@seqlane/core";
import {
  ExecutorError,
  InputValidationError,
  OutputValidationError,
  ValidationFailedError,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { mastraRuntimeSpineWorkflow } from "../../../fixtures/mastra-runtime-spine-workflow.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import { createMastraPlanExecution } from "./mastra-execution.js";
import { createMastraRuntime } from "./mastra-runtime.js";

const publicEntryPoint = fileURLToPath(
  new URL("../../index.ts", import.meta.url),
);

const passthroughSchema: SeqlaneSchema = {
  parse: (value) => value,
};

function taskPlan(id: string): Plan {
  return {
    workflow: { id },
    nodes: [
      {
        type: "task",
        taskId: "fixture-task",
        nodeId: "fixture-task:1",
        workspace: "shared",
        input: {},
        dependsOn: [],
      },
    ],
    output: { type: "ref", nodeId: "fixture-task:1", path: [] },
  };
}

function validationPlan(): Plan {
  return {
    workflow: { id: "fixture-validation" },
    nodes: [
      {
        type: "validation.check",
        nodeId: "validation.check:1",
        source: { type: "mechanical", validatorId: "fixture-validator" },
        input: {},
        dependsOn: [],
      },
      {
        type: "validation.gate",
        nodeId: "validation.gate:1",
        input: {},
        checkNodeId: "validation.check:1",
        policy: "fail",
        dependsOn: ["validation.check:1"],
      },
    ],
    output: { type: "ref", nodeId: "validation.gate:1", path: ["value"] },
  };
}

function fixtureTaskDefinitions(
  input: SeqlaneSchema = passthroughSchema,
  output: SeqlaneSchema = passthroughSchema,
): TaskDefinitionRegistry {
  const task: TaskDefinition = {
    id: "fixture-task",
    input,
    output,
    goal: () => "Run the fixture task",
  };
  return new Map([[task.id, task]]);
}

async function runMastraPlan(options: {
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly executor?: () => Promise<unknown>;
}) {
  const executor = {
    execute: async () => options.executor?.(),
  };
  const execution = createMastraPlanExecution({
    plan: options.plan,
    workflowInput: {},
    workId: "fixture-work",
    runId: "fixture-run",
    createInvocationId: (nodeId) => nodeId ?? "fixture-invocation",
    executors: { agent: () => executor },
    sessionResolver: {
      resolve: async () => ({ key: Symbol("fixture-session"), executor }),
    },
    workspaceResources: new Map(),
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    events: { emit: () => undefined },
  });
  await resolveCompiledWorkflowSessions(execution.legacy);
  return execution.runtime.run({
    workflowKey: options.plan.workflow.id,
    input: {},
    workId: "fixture-work",
    runId: "fixture-run",
  });
}

describe("private Mastra runtime spine", () => {
  it("executes a registered workflow and preserves run identity", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: "fixture",
        input: { fail: false },
        workId: "work-success",
        runId: "run-success",
      }),
    ).resolves.toEqual({
      status: "succeeded",
      result: {
        value: "Mastra runtime spine fixture succeeded",
        runId: "run-success",
        workId: "work-success",
      },
    });
  });

  it("normalizes a Mastra workflow failure without exposing Mastra details", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    const outcome = await runtime.run({
      workflowKey: "fixture",
      input: { fail: true },
      workId: "work-failure",
      runId: "run-failure",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;

    expect(outcome.error).toMatchObject({
      category: "RuntimeError",
      message: "Seqlane runtime failed: Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause).toBeInstanceOf(Error);
    if (!(outcome.error.cause instanceof Error)) return;

    expect(outcome.error.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
      name: "Error",
    });
  });

  it("keeps Mastra imports out of the package public entry point", () => {
    expect(readFileSync(publicEntryPoint, "utf8")).not.toContain("@mastra/");
  });

  it("normalizes cancellation from an active Mastra run", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const step = createStep({
      id: "cancellable",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new Error("step aborted")),
            { once: true },
          );
        });
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "cancellable-workflow",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
    const active = runtime.start({
      workflowKey: workflow.id,
      input: null,
      workId: "work-cancel",
      runId: "run-cancel",
    });

    await startedPromise;
    await active.cancel();
    await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("preserves typed Seqlane failures through the Mastra runner", async () => {
    const inputFailure: SeqlaneSchema = {
      parse: () => {
        throw new Error("invalid fixture input");
      },
    };
    const outputFailure: SeqlaneSchema = {
      parse: () => {
        throw new Error("invalid fixture output");
      },
    };
    const cases = [
      {
        name: "input validation",
        error: InputValidationError,
        category: "InputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-input-failure"),
        taskDefinitions: fixtureTaskDefinitions(inputFailure),
      },
      {
        name: "executor",
        error: ExecutorError,
        category: "ExecutorError",
        hasCause: true,
        plan: taskPlan("fixture-executor-failure"),
        taskDefinitions: fixtureTaskDefinitions(),
        executor: async () => {
          throw new Error("fixture executor failed");
        },
      },
      {
        name: "output validation",
        error: OutputValidationError,
        category: "OutputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-output-failure"),
        taskDefinitions: fixtureTaskDefinitions(
          passthroughSchema,
          outputFailure,
        ),
        executor: async () => ({ value: "invalid" }),
      },
      {
        name: "validation gate",
        error: ValidationFailedError,
        category: "ValidationError",
        hasCause: false,
        plan: validationPlan(),
        validatorDefinitions: new Map([
          [
            "fixture-validator",
            {
              id: "fixture-validator",
              input: passthroughSchema,
              validate: () => ({
                success: false as const,
                issues: [
                  { code: "rejected", message: "Fixture was rejected" },
                ] as const,
              }),
            },
          ],
        ]),
      },
    ];

    for (const testCase of cases) {
      const outcome = await runMastraPlan(testCase);

      expect(outcome.status, testCase.name).toBe("failed");
      if (outcome.status !== "failed") continue;
      expect(outcome.error, testCase.name).toBeInstanceOf(testCase.error);
      expect(outcome.error.category, testCase.name).toBe(testCase.category);
      if (testCase.hasCause) {
        expect(outcome.error.cause, testCase.name).toBeInstanceOf(Error);
      }
    }
  });
});
