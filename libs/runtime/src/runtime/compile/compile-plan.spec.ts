// @test-scope ./compile-plan.ts
// @test-scope ../validation/plan-validation.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../session/session-preflight.ts
import type {
  Plan,
  PlanNode,
  SeqlaneEvent,
  TaskContext,
  TaskDefinition,
  ValidationNode,
  ValueBinding,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanCompiler, compilePlan } from "./compile-plan.js";
import { executeSequentialProgram } from "../execution/program.js";
import type { ExecutorRequest } from "../execution/executor.js";
import { WORKFLOW_INPUT_NODE_ID } from "../plan/binding-resolution.js";
import {
  PlanValidationError,
  validatePlan,
} from "../validation/plan-validation.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  input: ValueBinding = {},
  workspace: "shared" | "exclusive" = "shared",
): Extract<PlanNode, { type: "task" }> {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace,
    input,
    dependsOn,
  };
}

function validationCheck(
  nodeId: string,
): Extract<ValidationNode, { type: "validation.check" }> {
  return {
    type: "validation.check",
    nodeId,
    source: { type: "mechanical", validatorId: "test-validator" },
    input: { candidate: "value" },
    dependsOn: [],
  } as Extract<ValidationNode, { type: "validation.check" }>;
}

function validationGate(
  nodeId: string,
  checkNodeId: string,
  policy: "fail" | "repeat-postcondition" = "fail",
  dependsOn: readonly string[] = [checkNodeId],
  input: ValueBinding = { candidate: "value" },
): ValidationNode {
  return {
    type: "validation.gate",
    nodeId,
    input,
    checkNodeId,
    policy,
    dependsOn,
  } as Extract<ValidationNode, { type: "validation.gate" }>;
}

function plan(nodes: readonly PlanNode[], output?: ValueBinding): Plan {
  const lastNode = nodes[nodes.length - 1];

  return {
    workflow: { id: "test-workflow" },
    nodes,
    output:
      output ??
      (lastNode ? { type: "ref", nodeId: lastNode.nodeId, path: [] } : null),
  };
}

function generatedTaskDefinitions(
  source: Plan,
  provided?: ReadonlyMap<string, TaskDefinition>,
): ReadonlyMap<string, TaskDefinition> {
  const definitions = new Map(provided);
  const nodes: PlanNode[] = [];
  const collect = (node: PlanNode): void => {
    nodes.push(node);
    if (node.type === "repeat") {
      collect(node.attempt);
    }
  };
  for (const node of source.nodes) collect(node);
  for (const node of nodes) {
    if (node.type !== "task" || definitions.has(node.taskId)) continue;
    const schema = z.unknown();
    definitions.set(node.taskId, {
      id: node.taskId,
      input: schema,
      output: schema,
      execute: async ({ context }) => context.runAgent({ goal: node.taskId }),
    });
  }
  return definitions;
}

function compileWorkflow(
  source: Plan,
  options: Parameters<PlanCompiler["compileWorkflow"]>[1],
) {
  return new PlanCompiler().compileWorkflow(source, {
    ...options,
    taskDefinitions: generatedTaskDefinitions(source, options.taskDefinitions),
  });
}

describe("PlanCompiler plan preparation", () => {
  it("orders a linear DAG topologically", () => {
    const source = plan([task("c", ["b"]), task("a"), task("b", ["a"])]);

    const result = compilePlan(source);

    expect(result.orderedNodes.map(({ nodeId }) => nodeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("orders a diamond DAG with a lexical tie-break", () => {
    const source = plan([
      task("result", ["left", "right"]),
      task("right", ["start"]),
      task("start"),
      task("left", ["start"]),
    ]);

    const result = new PlanCompiler().compile(source);

    expect(result.orderedNodes.map(({ nodeId }) => nodeId)).toEqual([
      "start",
      "left",
      "right",
      "result",
    ]);
  });

  it("uses lexical ordering for independent nodes regardless of input order", () => {
    const source = plan([task("z"), task("a"), task("m")]);

    expect(
      compilePlan(source).orderedNodes.map(({ nodeId }) => nodeId),
    ).toEqual(["a", "m", "z"]);
  });

  it("does not add execution dependencies from Plan declaration order", () => {
    const first = compileWorkflow(
      plan([task("z"), task("a"), task("result", ["a", "z"])]),
      { executors: new Map() },
    );
    const second = compileWorkflow(
      plan([task("a"), task("z"), task("result", ["a", "z"])]),
      { executors: new Map() },
    );

    expect(first.program.steps).toEqual(
      second.program.steps.map(({ id, dependsOn }) => ({
        id,
        dependsOn,
        execute: expect.any(Function),
      })),
    );
    expect(
      first.program.steps
        .filter((step) => step.id === "a" || step.id === "z")
        .map((step) => step.dependsOn),
    ).toEqual([[], []]);
  });

  it("lowers conflicting workspace access into execution dependencies", () => {
    const compiled = compileWorkflow(
      plan([
        task("writer", [], {}, "exclusive"),
        task("reader", [], {}, "shared"),
        task("result", ["reader", "writer"]),
      ]),
      {
        executors: new Map(),
        workspaceResources: new Map([
          ["reader", { key: "/checkout" }],
          ["writer", { key: "/checkout" }],
        ]),
      },
    );

    expect(compiled.program.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reader", dependsOn: [] }),
        expect.objectContaining({ id: "writer", dependsOn: ["reader"] }),
      ]),
    );
  });

  it.each([
    [
      "duplicate Plan node IDs",
      plan([task("same"), task("same")]),
      /duplicate Plan node ID/i,
    ],
    [
      "unknown dependency",
      plan([task("a", ["missing"])]),
      /unknown dependency/i,
    ],
    ["self dependency", plan([task("a", ["a"])]), /self-dependency/i],
    [
      "duplicate dependency",
      plan([task("a"), task("b", ["a", "a"])]),
      /duplicate dependency/i,
    ],
  ])("rejects %s", (_description, source, message) => {
    expect(() => validatePlan(source as Plan)).toThrow(message);
  });

  it("rejects an invalid task workspace policy", () => {
    const source = plan([task("task")]);
    Reflect.set(source.nodes[0]!, "workspace", "filesystem");

    expect(() => validatePlan(source)).toThrow(/workspace policy/i);
  });

  it("validates local task execution against its registered definition", () => {
    const local: TaskDefinition = {
      id: "local-task",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => ({}),
    };
    const source = plan([
      {
        ...task("local-task"),
      } as PlanNode,
    ]);

    expect(() =>
      validatePlan(source, new Map([[local.id, local]])),
    ).not.toThrow();
    expect(() => validatePlan(source, new Map())).toThrow(
      /no registered definition/i,
    );
  });

  it.each([
    [
      "executable binding fields",
      plan([
        {
          ...task("local-task"),
          input: { execute: async () => undefined } as never,
        } as PlanNode,
      ]),
    ],
    [
      "legacy executor metadata",
      plan([
        { ...task("local-task"), executor: "legacy" } as unknown as PlanNode,
      ]),
    ],
  ])("rejects non-canonical Plan %s", (_description, source) => {
    expect(() => validatePlan(source)).toThrow(/schema/i);
  });

  it("rejects structurally malformed Plans with a PlanValidationError", () => {
    const malformed = {
      workflow: { id: "malformed-plan" },
      nodes: [{ type: "task" }],
      output: null,
    } as unknown as Plan;

    expect(() => validatePlan(malformed)).toThrow(PlanValidationError);
  });

  it("rejects a task registry whose key does not match its definition ID", () => {
    const source = plan([task("local-task")]);
    const definition: TaskDefinition = {
      id: "different-id",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => ({}),
    };

    expect(() =>
      compileWorkflow(source, {
        executors: new Map(),
        taskDefinitions: new Map([["local-task", definition]]),
      }),
    ).toThrow(/registry keys must match task definition IDs/i);
  });

  it("rejects a validator registry whose key does not match its definition ID", () => {
    const check = validationCheck("check");
    const source = plan([check, validationGate("gate", check.nodeId)]);
    const validator = {
      id: "different-id",
      input: z.unknown(),
      validate: () => ({ success: true as const }),
    };

    expect(() =>
      compileWorkflow(source, {
        executors: new Map(),
        validatorDefinitions: new Map([["test-validator", validator]]),
      }),
    ).toThrow(/registry keys must match validator definition IDs/i);
  });

  it("accepts a unified definition used as a validation task source", () => {
    const local: TaskDefinition = {
      id: "local-validator",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => ({ success: true }),
    };
    const source = plan([
      {
        type: "validation.check",
        nodeId: "check",
        source: {
          type: "task",
          taskId: local.id,
          workspace: "shared",
        },
        input: {},
        dependsOn: [],
      } as PlanNode,
    ]);

    expect(() =>
      validatePlan(source, new Map([[local.id, local]])),
    ).not.toThrow();
  });

  it("accepts a task node without a task-kind discriminator", () => {
    const definition: TaskDefinition = {
      id: "unified-task",
      input: z.unknown(),
      output: z.unknown(),
      execute: async () => ({}),
    };
    const source = plan([task("unified-task")]);
    expect(() =>
      validatePlan(source, new Map([[definition.id, definition]])),
    ).not.toThrow();
  });

  it("rejects removed Seqlane permission configuration in a Plan", () => {
    const source = plan([task("task")]);
    Reflect.set(source.nodes[0]!, "permissions", { workspace: "read" });

    expect(() => validatePlan(source)).toThrow(/permission configuration/i);
  });

  it("rejects dependency cycles", () => {
    const source = plan([task("a", ["b"]), task("b", ["a"])]);

    expect(() => compilePlan(source)).toThrow(/cycle/i);
  });

  it("serializes multiple reuse consumers of one session checkpoint", () => {
    const source = task("source");
    const first = {
      ...task("first", ["source"]),
      session: { type: "reuse" as const, from: "source" },
    };
    const second = {
      ...task("second", ["source"]),
      session: { type: "reuse" as const, from: "source" },
    };

    const sourcePlan = plan([source, first, second]);
    expect(() => validatePlan(sourcePlan)).not.toThrow();

    const compiled = compileWorkflow(sourcePlan, {
      executors: new Map(),
    });
    expect(
      compiled.orderedNodes.map((node) => [node.nodeId, node.dependsOn]),
    ).toEqual([
      ["source", []],
      ["first", ["source"]],
      ["second", ["source", "first"]],
    ]);
    expect(
      compiled.plan.nodes.find((node) => node.nodeId === "second"),
    ).toMatchObject({ dependsOn: ["source", "first"] });
  });

  it("accepts statically resolvable session selections and model changes on branches", () => {
    const source = {
      ...task("source"),
      session: {
        type: "isolated" as const,
        model: {
          model: { provider: "openai", model: "gpt-5.6-luna" },
          reasoning: "high" as const,
        },
      },
    };
    const branch = {
      ...task("branch", ["source"]),
      session: {
        type: "branch" as const,
        from: "source",
        model: {
          model: { provider: "anthropic", model: "claude-sonnet-4" },
          reasoning: "low" as const,
        },
      },
    };
    const reuse = {
      ...task("reuse", ["source"]),
      session: { type: "reuse" as const, from: "source" },
    };

    expect(() => validatePlan(plan([source, branch, reuse]))).not.toThrow();
  });

  it("validates model selections with the canonical schema", () => {
    const source = task("source");
    Reflect.set(source, "session", {
      type: "isolated",
      model: {
        model: { provider: "openai", model: "gpt-5.6-luna" },
        reasoning: "unsupported",
      },
    });

    try {
      validatePlan(plan([source]));
      expect.fail("expected validation to fail");
    } catch (error) {
      expect((error as PlanValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid-session-model" }),
        ]),
      );
    }
  });

  it("rejects a model field on reuse with an actionable conflict", () => {
    const source = {
      ...task("source"),
      session: {
        type: "isolated" as const,
        model: {
          model: { provider: "openai", model: "gpt-5.6-luna" },
          reasoning: "high" as const,
        },
      },
    };
    const reuse = {
      ...task("reuse", ["source"]),
      session: {
        type: "reuse" as const,
        from: "source",
        model: {
          model: { provider: "anthropic", model: "claude-sonnet-4" },
          reasoning: "low" as const,
        },
      },
    } as unknown as PlanNode;

    try {
      validatePlan(plan([source, reuse]));
      expect.fail("expected validation to fail");
    } catch (error) {
      expect((error as PlanValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "session-model-conflict",
            message: expect.stringMatching(
              /openai\/gpt-5\.6-luna.*anthropic\/claude-sonnet-4|anthropic\/claude-sonnet-4.*openai\/gpt-5\.6-luna/,
            ),
          }),
        ]),
      );
      expect((error as PlanValidationError).message).toMatch(
        /branch or isolated/i,
      );
    }
  });

  it("describes cycles that include a session dependency", () => {
    const source = task("source", ["consumer"]);
    const consumer = {
      ...task("consumer", ["source"]),
      session: { type: "reuse" as const, from: "source" },
    };

    expect(() => validatePlan(plan([source, consumer]))).toThrow(
      /source.*consumer.*session:reuse|session:reuse.*source.*consumer/i,
    );
  });

  it("rejects a cycle in a disconnected task dependency graph", () => {
    const source = plan([
      task("independent"),
      task("draft", ["review"]),
      task("review", ["publish"]),
      task("publish", ["draft"]),
    ]);

    expect(() => compilePlan(source)).toThrow(/cycle/i);
  });

  it("prepares validation nodes for runtime execution", () => {
    expect(() =>
      compileWorkflow(plan([validationCheck("check")]), {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map(),
        validatorDefinitions: new Map([
          [
            "test-validator",
            {
              id: "test-validator",
              input: z.unknown(),
              validate: () => ({ success: true }),
            },
          ],
        ]),
      }),
    ).not.toThrow();
  });

  it("rejects a ValueRef whose target is not a node", () => {
    const source = plan([
      task("consumer", [], {
        nested: [{ type: "ref", nodeId: "missing", path: [] }],
      }),
    ]);

    expect(() => compilePlan(source)).toThrow(/unknown ValueRef target/i);
  });

  it("rejects a node ValueRef that is not represented by a dependency edge", () => {
    const source = plan([
      task("producer"),
      task("consumer", [], {
        value: { type: "ref", nodeId: "producer", path: ["output"] },
      }),
    ]);

    expect(() => compilePlan(source)).toThrow(/ValueRef target.*dependency/i);
  });

  it("reports malformed ValueRef paths as validation issues", () => {
    const source = plan([
      task("consumer", [], {
        value: {
          type: "ref",
          nodeId: "consumer",
          path: [42],
        } as unknown as ValueBinding,
      }),
    ]);

    try {
      validatePlan(source);
      expect.fail("expected validation to fail");
    } catch (error) {
      expect((error as PlanValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-value-ref-path",
            message: 'ValueRef in "consumer" must have a string path',
          }),
        ]),
      );
    }
  });

  it("rejects an output ValueRef whose target is not a node", () => {
    const source = plan([task("producer")], {
      type: "ref",
      nodeId: "missing",
      path: [],
    });

    expect(() => compilePlan(source)).toThrow(/unknown ValueRef target/i);
  });

  it("does not mutate the source Plan or its node arrays", () => {
    const source = plan([task("b", ["a"]), task("a")]);
    const snapshot = structuredClone(source);

    compilePlan(source);

    expect(source).toEqual(snapshot);
    expect(source.nodes.map(({ nodeId }) => nodeId)).toEqual(["b", "a"]);
    expect(source.nodes[0]?.dependsOn).toEqual(["a"]);
  });

  it("reports validation failures with structured issues", () => {
    const source = plan([task("a", ["a"])]);

    try {
      validatePlan(source);
      expect.fail("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
      expect((error as PlanValidationError).issues[0]?.code).toBe(
        "self-dependency",
      );
    }
  });

  it("validates bounded repeat attempts and conditions", () => {
    const valid: Plan = {
      workflow: { id: "repeat" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: { passed: false },
          dependsOn: [],
          maximumIterations: 2,
          attempt: task("repeat:1:attempt", [], {
            type: "ref",
            nodeId: "repeat:1:input",
            path: [],
          }),
          until: {
            type: "ref",
            nodeId: "repeat:1:attempt",
            path: ["output", "passed"],
          },
          nextInput: {
            type: "ref",
            nodeId: "repeat:1:attempt",
            path: ["output"],
          },
        },
      ],
      output: { type: "ref", nodeId: "repeat:1", path: ["output"] },
    };

    expect(() => validatePlan(valid)).not.toThrow();
    expect(() =>
      validatePlan({
        ...valid,
        nodes: [
          {
            ...(valid.nodes[0] as Extract<PlanNode, { type: "repeat" }>),
            maximumIterations: 0,
          },
        ],
      }),
    ).toThrow(/positive integer/i);
  });

  it.each([
    [
      "a repeat postcondition gate outside a repeat",
      plan([
        validationCheck("check"),
        validationGate("gate", "check", "repeat-postcondition", ["check"]),
      ]),
      /repeat-postcondition.*repeat body/i,
    ],
    [
      "a gate whose check is not a dependency",
      plan([
        validationCheck("check"),
        validationGate("gate", "check", "fail", []),
      ]),
      /check.*dependency/i,
    ],
  ])("rejects %s", (_description, source, message) => {
    expect(() => validatePlan(source as Plan)).toThrow(message);
  });

  it.each([
    ["an empty node ID", plan([task("")]), "empty-node-id"],
    [
      "an invalid validation source",
      plan([
        {
          ...validationCheck("check"),
          source: { type: "unknown" },
        } as unknown as PlanNode,
      ]),
      "invalid-validation-source",
    ],
    [
      "an invalid validation policy",
      plan([
        validationCheck("check"),
        {
          ...validationGate("gate", "check"),
          policy: "unknown",
        } as unknown as PlanNode,
      ]),
      "invalid-validation-policy",
    ],
    [
      "a gate targeting a task",
      plan([
        task("task"),
        {
          ...validationGate("gate", "task"),
          dependsOn: ["task"],
        } as unknown as PlanNode,
      ]),
      "unknown-validation-check",
    ],
  ])("rejects %s", (_description, source, code) => {
    expect(() => validatePlan(source as Plan)).toThrow();
    try {
      validatePlan(source as Plan);
    } catch (error) {
      expect((error as PlanValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    }
  });
});

describe("PlanCompiler workflow compilation", () => {
  function executablePlan(): Plan {
    return plan([task("z"), task("a"), task("result", ["a", "z"])]);
  }

  it("creates one typed generated step plus the result step", () => {
    const source = executablePlan();
    const compiled = compileWorkflow(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.type === "task"
            ? { ...node, session: { type: "isolated" as const } }
            : node,
        ),
      },
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map(),
      },
    );

    expect(compiled.program.steps.map((step) => step.id)).toEqual([
      "a",
      "z",
      "result",
      "__seqlane_result",
    ]);
  });

  it("bypasses runtime workspace admission for graph-lowered top-level tasks", async () => {
    let executed = false;
    const events: SeqlaneEvent[] = [];
    const workspace = { key: "/checkout" };
    const compiled = compileWorkflow(
      plan([task("writer", [], {}, "exclusive")]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          [
            "test-executor",
            {
              execute: async () => {
                executed = true;
                return { written: true };
              },
            },
          ],
        ]),
        workspaceResources: new Map([["writer", workspace]]),
        events: { emit: (event) => events.push(event) },
      },
    );
    const externalLease = await compiled.context.workspaceLocks.acquire(
      workspace,
      "exclusive",
    );

    const execution = executeSequentialProgram(compiled.program);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const executedBeforeRelease = executed;
    externalLease.release();
    const result = await execution;

    expect(executedBeforeRelease).toBe(true);
    expect(result.status).toBe("success");
    expect(
      events
        .filter((event) => event.type === "invocation.progress")
        .map((event) => event.phase),
    ).toEqual(
      expect.arrayContaining(["workspace_admitted", "workspace_released"]),
    );
  });

  it("executes admitted independent nodes before either one completes", async () => {
    const calls: string[] = [];
    const requests: ExecutorRequest[] = [];
    let markBothIndependentNodesStarted!: () => void;
    const bothIndependentNodesStarted = new Promise<void>((resolve) => {
      markBothIndependentNodesStarted = resolve;
    });
    const startedIndependentNodes = new Set<string>();
    let releaseIndependentNodes!: () => void;
    const independentNodesReleased = new Promise<void>((resolve) => {
      releaseIndependentNodes = resolve;
    });
    const executor = {
      execute: async (request: ExecutorRequest) => {
        requests.push(request);
        calls.push(`${request.invocationId}:start`);
        if (request.invocationId === "a" || request.invocationId === "z") {
          startedIndependentNodes.add(request.invocationId);
          if (startedIndependentNodes.size === 2) {
            markBothIndependentNodesStarted();
          }
          await independentNodesReleased;
        }
        calls.push(`${request.invocationId}:end`);
        return { nodeId: request.invocationId };
      },
    };
    const schema = z.unknown();
    const compiled = compileWorkflow(
      plan([
        task("z", [], {}, "shared"),
        task("a", [], {}, "shared"),
        task("result", ["a", "z"]),
      ]),
      {
        workflowInput: { source: "test" },
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([["test-executor", executor]]),
        sessionResolver: {
          resolve: async ({ invocationId }) => ({
            key: Symbol(invocationId),
            executor,
          }),
        },
        taskDefinitions: new Map([
          [
            "a",
            {
              id: "a",
              input: schema,
              output: schema,
              execute: async ({ context }) => context.runAgent({ goal: "a" }),
            },
          ],
          [
            "z",
            {
              id: "z",
              input: schema,
              output: schema,
              execute: async ({ context }) => context.runAgent({ goal: "z" }),
            },
          ],
          [
            "result",
            {
              id: "result",
              input: schema,
              output: schema,
              execute: async ({ context }) =>
                context.runAgent({ goal: "result" }),
            },
          ],
        ]),
        workspaceResources: new Map([
          ["a", { key: "/checkout" }],
          ["z", { key: "/checkout" }],
        ]),
      },
    );
    await resolveCompiledWorkflowSessions(compiled);
    const execution = executeSequentialProgram(compiled.program);
    const startState = await Promise.race([
      bothIndependentNodesStarted.then(() => "started"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 0)),
    ]);
    releaseIndependentNodes();
    await execution;

    expect(startState).toBe("started");
    expect(calls).toEqual(
      expect.arrayContaining(["a:start", "z:start", "a:end", "z:end"]),
    );
    expect(calls.indexOf("result:start")).toBeGreaterThan(
      calls.indexOf("a:end"),
    );
    expect(calls.indexOf("result:start")).toBeGreaterThan(
      calls.indexOf("z:end"),
    );
    expect(requests).toHaveLength(3);
    expect(compiled.context.results).toEqual(new Map());
  });

  it("does not execute a dependent task after its predecessor fails", async () => {
    const executedTaskIds: string[] = [];
    const compiled = compileWorkflow(
      plan([task("dependent", ["predecessor"]), task("predecessor")]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          [
            "test-executor",
            {
              execute: async (request: ExecutorRequest) => {
                executedTaskIds.push(request.taskId);
                if (request.taskId === "predecessor") {
                  throw new Error("predecessor failed");
                }
                return { ok: true };
              },
            },
          ],
        ]),
      },
    );

    const result = await executeSequentialProgram(compiled.program);

    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/predecessor failed/i) },
    });
    expect(executedTaskIds).toEqual(["predecessor"]);
  });

  it("allocates runtime invocation IDs without changing Plan-node bindings", async () => {
    const requests: ExecutorRequest[] = [];
    const compiled = compileWorkflow(executablePlan(), {
      createInvocationId: (nodeId) => `inv:${nodeId}`,
      executors: new Map([
        [
          "test-executor",
          {
            execute: async (request: ExecutorRequest) => {
              requests.push(request);
              return { nodeId: request.invocationId };
            },
          },
        ],
      ]),
    });

    expect(compiled.context.invocationIds).toEqual(
      new Map([
        ["a", "inv:a"],
        ["z", "inv:z"],
        ["result", "inv:result"],
      ]),
    );

    await executeSequentialProgram(compiled.program);

    expect(requests.map(({ invocationId }) => invocationId)).toEqual([
      "inv:a",
      "inv:z",
      "inv:result",
    ]);
    expect([...compiled.context.results.keys()]).toEqual([]);
  });

  it("resolves one executor session for each task before execution", async () => {
    const resolvedInvocations: string[] = [];
    const executedSessions: string[] = [];
    const taskSchema = z.unknown();
    const taskDefinitions = new Map(
      ["a", "z", "result"].map((taskId) => [
        taskId,
        {
          id: taskId,
          input: taskSchema,
          output: taskSchema,
          execute: async ({ context }: { context: TaskContext }) =>
            context.runAgent({ goal: taskId }),
        },
      ]),
    );
    const source = executablePlan();
    const compiled = compileWorkflow(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.type === "task"
            ? { ...node, session: { type: "isolated" as const } }
            : node,
        ),
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([
          [
            "test-executor",
            { execute: async () => ({ source: "unresolved executor" }) },
          ],
        ]),
        taskDefinitions,
        sessionResolver: {
          resolve: async ({ invocationId }) => {
            resolvedInvocations.push(invocationId);
            return {
              key: Symbol(invocationId),
              executor: {
                execute: async (request: ExecutorRequest) => {
                  executedSessions.push(invocationId);
                  return { nodeId: request.invocationId };
                },
              },
            };
          },
        },
      },
    );

    await resolveCompiledWorkflowSessions(compiled);

    expect(resolvedInvocations).toEqual(["inv:a", "inv:z", "inv:result"]);
    expect([...compiled.context.resolvedSessions.keys()]).toEqual([
      "inv:a",
      "inv:z",
      "inv:result",
    ]);

    await executeSequentialProgram(compiled.program);

    expect(executedSessions).toEqual(["inv:a", "inv:z", "inv:result"]);
  });

  function schema<T>(parse: (value: unknown) => T): z.ZodType<T> {
    return z.any().transform(parse);
  }

  it("resolves workflow and prior-result bindings before executor invocation", async () => {
    const requests: ExecutorRequest[] = [];
    const source = task("source", [], {
      value: {
        type: "ref",
        nodeId: WORKFLOW_INPUT_NODE_ID,
        path: ["request", "value"],
      },
    });
    const consumer = task("consumer", ["source"], {
      value: {
        type: "ref",
        nodeId: "source",
        path: ["answer"],
      },
    });
    const compiled = compileWorkflow(plan([consumer, source]), {
      workflowInput: { request: { value: "from-input" } },
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        [
          "test-executor",
          {
            execute: async (request: ExecutorRequest) => {
              requests.push(request);
              return request.invocationId === "source"
                ? { answer: "from-source" }
                : { answer: request.input };
            },
          },
        ],
      ]),
      taskSchemas: new Map([
        [
          "source",
          {
            input: schema((value) => {
              expect(value).toEqual({ value: "from-input" });
              return value;
            }),
            output: schema((value) => {
              expect(value).toEqual({ answer: "from-source" });
              return value;
            }),
          },
        ],
        [
          "consumer",
          {
            input: schema((value) => {
              expect(value).toEqual({ value: "from-source" });
              return value;
            }),
            output: schema((value) => value),
          },
        ],
      ]),
    });

    await executeSequentialProgram(compiled.program);

    expect(requests.map(({ input }) => input)).toEqual([
      { value: "from-input" },
      { value: "from-source" },
    ]);
    expect(compiled.context.results.has("source")).toBe(false);
  });

  it("fails before invoking an executor when task input validation fails", async () => {
    let calls = 0;
    const compiled = compileWorkflow(plan([task("a")]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        [
          "test-executor",
          {
            execute: async () => {
              calls += 1;
              return { ok: true };
            },
          },
        ],
      ]),
      taskSchemas: new Map([
        [
          "a",
          {
            input: schema(() => {
              throw new Error("invalid input");
            }),
            output: schema((value) => value),
          },
        ],
      ]),
    });
    const result = await executeSequentialProgram(compiled.program);
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/invalid input/i) },
    });
    expect(calls).toBe(0);
  });

  it("fails and does not store output when output validation fails", async () => {
    const compiled = compileWorkflow(plan([task("a")]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        ["test-executor", { execute: async () => ({ ok: false }) }],
      ]),
      taskSchemas: new Map([
        [
          "a",
          {
            input: schema((value) => value),
            output: schema(() => {
              throw new Error("invalid output");
            }),
          },
        ],
      ]),
    });
    const result = await executeSequentialProgram(compiled.program);
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/invalid output/i) },
    });
    expect(compiled.context.results.has("a")).toBe(false);
  });
});
