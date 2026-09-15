// @test-scope ../compile/compile-plan.ts
import type {
  Plan,
  PlanNode,
  TaskDefinition,
  TaskNode,
  SeqlaneEvent,
  SeqlaneSchema,
  ValidationResult,
  ValidatorDefinitionRegistry,
  ValueBinding,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ExecutorError,
  OutputValidationError,
  RuntimeError,
  ValidationFailedError,
  runCompiledWorkflow,
  startCompiledWorkflow,
} from "../../index.js";
import { parseValidationResult } from "./validation-results.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "../execution/executor.js";

const schema = <T>(): SeqlaneSchema<T> => z.any() as SeqlaneSchema<T>;

describe("validation result error classification", () => {
  it("classifies malformed evidence by stable issue code and path", () => {
    expect(() =>
      parseValidationResult({
        success: true,
        evidence: new Date(),
      }),
    ).toThrow("Validation evidence must be JSON-safe");
  });

  it("classifies an empty failed issue list by its stable issues path", () => {
    expect(() => parseValidationResult({ success: false, issues: [] })).toThrow(
      "A failed validation result must contain at least one issue",
    );
  });
});

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  input: ValueBinding = {},
): TaskNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input,
    dependsOn,
  } as TaskNode;
}

function validationPlan(
  source: PlanNode["type"] extends never ? never : "mechanical" | "task",
  sourceId: string,
  downstream = true,
): Plan {
  const input = { type: "ref", nodeId: "__seqlane_input", path: [] } as const;
  const checkNodeId = "validation.check:1";
  const gateNodeId = "validation.gate:1";
  const check: PlanNode = {
    type: "validation.check",
    nodeId: checkNodeId,
    source:
      source === "mechanical"
        ? { type: "mechanical", validatorId: sourceId }
        : { type: "task", taskId: sourceId, workspace: "shared" },
    input,
    dependsOn: [],
  };
  const gate: PlanNode = {
    type: "validation.gate",
    nodeId: gateNodeId,
    input,
    checkNodeId,
    policy: "fail",
    dependsOn: [checkNodeId],
  };
  const nodes: PlanNode[] = [check, gate];
  if (downstream) {
    nodes.push(
      task("downstream", [gateNodeId], {
        value: { type: "ref", nodeId: gateNodeId, path: ["value"] },
      }),
    );
  }
  return {
    workflow: { id: "validation-runtime" },
    nodes,
    output: downstream
      ? { type: "ref", nodeId: "downstream", path: ["output"] }
      : { type: "ref", nodeId: gateNodeId, path: ["value"] },
  };
}

function compile(
  plan: Plan,
  options: {
    readonly executor?: (request: ExecutorRequest) => Promise<unknown>;
    readonly validators?: ValidatorDefinitionRegistry;
    readonly taskDefinitions?: ReadonlyMap<string, TaskDefinition>;
    readonly events?: {
      emit(event: SeqlaneEvent): void;
    };
  } = {},
) {
  const taskDefinitions = new Map(options.taskDefinitions);
  const nodes: PlanNode[] = [];
  const collect = (node: PlanNode): void => {
    nodes.push(node);
    if (node.type === "repeat") {
      collect(node.attempt);
    }
  };
  for (const node of plan.nodes) collect(node);
  for (const node of nodes) {
    if (node.type !== "task" || taskDefinitions.has(node.taskId)) continue;
    const taskSchema = z.unknown();
    taskDefinitions.set(node.taskId, {
      id: node.taskId,
      input: taskSchema,
      output: taskSchema,
      execute: async ({ context }) => context.runAgent({ goal: node.taskId }),
    });
  }
  return new PlanCompiler().compileWorkflow(plan, {
    workflowInput: { value: "candidate" },
    createInvocationId: (nodeId) => nodeId,
    executors: new Map([
      [
        "test-executor",
        { execute: options.executor ?? (async () => ({ value: "output" })) },
      ],
    ]),
    validatorDefinitions: options.validators,
    taskDefinitions,
    events: options.events,
  });
}

describe("runtime validation execution", () => {
  it("emits validation subjects without compatibility task IDs", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(validationPlan("mechanical", "accept", false), {
      events: { emit: (event) => events.push(event) },
      validators: new Map([
        [
          "accept",
          {
            id: "accept",
            input: schema(),
            validate: () => ({ success: true }),
          },
        ],
      ]) as ValidatorDefinitionRegistry,
    });

    await runCompiledWorkflow(compiled);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.created",
        kind: "validation",
        subject: { type: "validator", validatorId: "accept" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.created",
        kind: "validation",
        subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
      }),
    );
    expect(
      events.find(
        (event) =>
          event.type === "invocation.created" &&
          event.subject.type === "validator",
      ),
    ).not.toHaveProperty("taskId");
  });

  it("passes a mechanical gate and executes its dependent", async () => {
    const calls: string[] = [];
    const compiled = compile(validationPlan("mechanical", "accept"), {
      validators: new Map([
        [
          "accept",
          {
            id: "accept",
            input: schema<{ readonly value: string }>(),
            validate: (input) => {
              expect(input).toEqual({ value: "candidate" });
              return { success: true, evidence: { checked: true } };
            },
          },
        ],
      ]) as ValidatorDefinitionRegistry,
      executor: async ({ taskId }) => {
        calls.push(taskId);
        return { value: "dependent-output" };
      },
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "dependent-output" },
    });
    expect(calls).toEqual(["downstream"]);
  });

  it("fails a normal gate and does not execute dependents", async () => {
    const calls: string[] = [];
    const compiled = compile(validationPlan("mechanical", "reject"), {
      validators: new Map([
        [
          "reject",
          {
            id: "reject",
            input: schema(),
            validate: () => ({
              success: false,
              issues: [{ code: "unsafe", message: "Candidate is unsafe" }],
              evidence: { reason: "policy" },
            }),
          },
        ],
      ]),
      executor: async ({ taskId }) => {
        calls.push(taskId);
        return { value: "unexpected" };
      },
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toBeInstanceOf(ValidationFailedError);
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toMatchObject({
      nodeId: "validation.gate:1",
      sourceId: "reject",
      evidence: { reason: "policy" },
    });
    expect(calls).toEqual([]);
  });

  it("fails malformed mechanical results closed", async () => {
    const compiled = compile(validationPlan("mechanical", "malformed"), {
      validators: new Map([
        [
          "malformed",
          {
            id: "malformed",
            input: schema(),
            validate: () => ({ success: false }) as never,
          },
        ],
      ]),
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    const error = (outcome as Extract<typeof outcome, { status: "failed" }>)
      .error;
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.message).toContain(
      "Validation result must have success true or success false with issues",
    );
  });

  it("fails mechanical results with non-JSON evidence closed", async () => {
    const compiled = compile(validationPlan("mechanical", "non-json"), {
      validators: new Map([
        [
          "non-json",
          {
            id: "non-json",
            input: schema(),
            validate: () => ({ success: true, evidence: new Date() }) as never,
          },
        ],
      ]),
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    const error = (outcome as Extract<typeof outcome, { status: "failed" }>)
      .error;
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.message).toContain("Validation evidence must be JSON-safe");
  });

  it.each([
    ["passed", { success: true, evidence: undefined }],
    [
      "failed",
      {
        success: false,
        issues: [{ code: "invalid", message: "Invalid candidate" }],
        evidence: undefined,
      },
    ],
  ])(
    "rejects an explicitly undefined %s evidence field",
    async (_case, result) => {
      const compiled = compile(
        validationPlan("mechanical", "undefined-evidence"),
        {
          validators: new Map([
            [
              "undefined-evidence",
              {
                id: "undefined-evidence",
                input: schema(),
                validate: () => result as never,
              },
            ],
          ]),
        },
      );

      const outcome = await runCompiledWorkflow(compiled);

      expect(outcome.status).toBe("failed");
      const error = (outcome as Extract<typeof outcome, { status: "failed" }>)
        .error;
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error.message).toContain("Validation evidence must be JSON-safe");
    },
  );

  it("executes evaluator validators through the task lifecycle", async () => {
    const evaluator: TaskDefinition = {
      id: "evaluator",
      input: schema<{ readonly value: string }>(),
      output: schema<ValidationResult>(),
      execute: async ({ context }) => context.runAgent({ goal: "evaluate" }),
    };
    const compiled = compile(validationPlan("task", "evaluator"), {
      taskDefinitions: new Map([[evaluator.id, evaluator]]),
      executor: async ({ taskId }) => {
        if (taskId === evaluator.id) {
          return { success: true, evidence: { evaluator: true } };
        }
        return { value: "output" };
      },
    });

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "output" },
    });
  });

  it("applies evaluator output validation and does not retry errors", async () => {
    let attempts = 0;
    const evaluator: TaskDefinition = {
      id: "malformed-evaluator",
      input: schema(),
      output: schema<ValidationResult>(),
      execute: async ({ context }) => context.runAgent({ goal: "evaluate" }),
    };
    const compiled = compile(
      validationPlan("task", "malformed-evaluator", false),
      {
        taskDefinitions: new Map([[evaluator.id, evaluator]]),
        executor: async () => {
          attempts += 1;
          return { nope: true };
        },
      },
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toBeInstanceOf(OutputValidationError);
    expect(attempts).toBe(1);
  });

  it("propagates evaluator executor errors", async () => {
    const evaluator: TaskDefinition = {
      id: "failing-evaluator",
      input: schema(),
      output: schema<ValidationResult>(),
      execute: async ({ context }) => context.runAgent({ goal: "evaluate" }),
    };
    const compiled = compile(validationPlan("task", evaluator.id, false), {
      taskDefinitions: new Map([[evaluator.id, evaluator]]),
      executor: async () => {
        throw new Error("evaluator failed");
      },
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<typeof outcome, { status: "failed" }>).error,
    ).toBeInstanceOf(ExecutorError);
  });

  it("cancels an active evaluator without retry", async () => {
    let attempts = 0;
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const evaluator: TaskDefinition = {
      id: "blocking-evaluator",
      input: schema(),
      output: schema<ValidationResult>(),
      execute: async ({ context }) => context.runAgent({ goal: "evaluate" }),
    };
    const compiled = compile(validationPlan("task", evaluator.id, false), {
      taskDefinitions: new Map([[evaluator.id, evaluator]]),
      executor: async ({ signal }) => {
        attempts += 1;
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            markAborted();
            reject(new Error("aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        return { success: true };
      },
    });

    const activeRun = startCompiledWorkflow(compiled);
    await started;
    await activeRun.cancel();
    await aborted;

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(attempts).toBe(1);
  });

  it("releases check results and validation envelopes by consumer lifetime", async () => {
    const compiled = compile(validationPlan("mechanical", "accept", false), {
      validators: new Map([
        [
          "accept",
          {
            id: "accept",
            input: schema(),
            validate: () => ({ success: true }),
          },
        ],
      ]),
    });

    await runCompiledWorkflow(compiled);

    expect(compiled.context.results).toEqual(new Map());
  });

  it("rejects a missing mechanical validator before execution", () => {
    expect(() => compile(validationPlan("mechanical", "missing"))).toThrow(
      /validator.*missing.*registered/i,
    );
  });

  it("rejects a missing evaluator task before execution", () => {
    expect(() => compile(validationPlan("task", "missing-evaluator"))).toThrow(
      /evaluator task definition.*missing-evaluator/i,
    );
  });
});
