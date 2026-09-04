// @test-scope ./compile-plan.ts
// @test-scope ../validation/plan-validation.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../session/session-preflight.ts
import type {
  Plan,
  PlanNode,
  SeqlaneEvent,
  TaskDefinition,
  SeqlaneSchema,
  ValidationNode,
  ValueBinding,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { EffectCompiler, compilePlan } from "./compile-plan.js";
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
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace,
    executor: "test-executor",
    input,
    dependsOn,
  } as PlanNode;
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

describe("EffectCompiler plan preparation", () => {
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

    const result = new EffectCompiler().compile(source);

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
    const first = new EffectCompiler().compileWorkflow(
      plan([task("z"), task("a"), task("result", ["a", "z"])]),
      { executors: new Map() },
    );
    const second = new EffectCompiler().compileWorkflow(
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
    const compiled = new EffectCompiler().compileWorkflow(
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
      input: { parse: (value: unknown) => value },
      output: { parse: (value: unknown) => value },
      execute: async () => ({}),
    };
    const source = plan([
      {
        ...task("local-task"),
        execution: "local",
      } as PlanNode,
    ]);

    expect(() =>
      validatePlan(source, new Map([[local.id, local]])),
    ).not.toThrow();
    expect(() => validatePlan(source, new Map())).toThrow(
      /no registered definition/i,
    );
  });

  it("rejects a local definition used as a validation task source", () => {
    const local: TaskDefinition = {
      id: "local-validator",
      input: { parse: (value: unknown) => value },
      output: { parse: (value: unknown) => value },
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

    expect(() => validatePlan(source, new Map([[local.id, local]]))).toThrow(
      /agent task definition/i,
    );
  });

  it.each([
    [
      "an invalid execution kind",
      { execution: "shell" },
      "invalid-task-execution",
    ],
    [
      "a local task session",
      { execution: "local", session: { type: "isolated" } },
      "local-task-session",
    ],
    [
      "a mismatched task definition",
      { execution: "local" },
      "task-definition-kind-mismatch",
    ],
  ])("rejects %s", (_description, fields, code) => {
    const agent: TaskDefinition = {
      id: "task-kind",
      input: { parse: (value: unknown) => value },
      output: { parse: (value: unknown) => value },
      goal: () => "work",
    };
    const source = plan([
      {
        ...task("task-kind"),
        ...fields,
      } as unknown as PlanNode,
    ]);

    expect(() => validatePlan(source, new Map([[agent.id, agent]]))).toThrow();
    try {
      validatePlan(source, new Map([[agent.id, agent]]));
    } catch (error) {
      expect((error as PlanValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    }
  });

  it("treats a task without execution as a legacy agent task", () => {
    expect(() => validatePlan(plan([task("legacy-task")]))).not.toThrow();
  });

  it("rejects removed Seqlane permission configuration in a Plan", () => {
    const source = plan([task("task")]);
    Reflect.set(source.nodes[0]!, "permissions", { workspace: "read" });

    expect(() => validatePlan(source)).toThrow(/permission configuration/i);
  });

  it("rejects an invalid repeat-body task workspace policy", () => {
    const bodyTask: Extract<PlanNode, { type: "task" }> = {
      type: "task",
      taskId: "task",
      nodeId: "repeat:1/task:1",
      workspace: "shared",
      input: {
        type: "ref",
        nodeId: "repeat:1:input",
        path: [],
      },
      dependsOn: ["repeat:1:input"],
    };
    const source: Plan = {
      workflow: { id: "invalid-repeat-workspace" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: { complete: false },
          dependsOn: [],
          maximumIterations: 1,
          body: {
            inputNodeId: "repeat:1:input",
            nodes: [bodyTask],
            output: {
              type: "ref",
              nodeId: "repeat:1/task:1",
              path: ["output"],
            },
            until: {
              type: "ref",
              nodeId: "repeat:1/task:1",
              path: ["output", "complete"],
            },
          },
        },
      ],
      output: { type: "ref", nodeId: "repeat:1", path: ["output"] },
    };
    Reflect.set(bodyTask, "workspace", "filesystem");

    expect(() => validatePlan(source)).toThrow(/workspace policy/i);
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

    const compiled = new EffectCompiler().compileWorkflow(sourcePlan, {
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
      new EffectCompiler().compileWorkflow(plan([validationCheck("check")]), {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map(),
        validatorDefinitions: new Map([
          [
            "test-validator",
            {
              id: "test-validator",
              input: { parse: (value: unknown) => value },
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

  it("validates bounded repeat bodies and conditions", () => {
    const valid: Plan = {
      workflow: { id: "repeat" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: { passed: false },
          dependsOn: [],
          maximumIterations: 2,
          body: {
            inputNodeId: "repeat:1:input",
            nodes: [
              task("repeat:1/repair:1", ["repeat:1:input"], {
                type: "ref",
                nodeId: "repeat:1:input",
                path: [],
              }) as Extract<PlanNode, { type: "task" }>,
            ],
            output: {
              type: "ref",
              nodeId: "repeat:1/repair:1",
              path: ["output"],
            },
            until: {
              type: "ref",
              nodeId: "repeat:1/repair:1",
              path: ["output", "passed"],
            },
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

  it("accepts a body-local repeat postcondition gate in final position", () => {
    const inputNodeId = "repeat:1:input";
    const taskNodeId = "repeat:1/repair:1";
    const checkNodeId = "repeat:1/check:1";
    const gateNodeId = "repeat:1/gate:1";
    const valid: Plan = {
      workflow: { id: "validated-repeat" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: { passed: false },
          dependsOn: [],
          maximumIterations: 2,
          body: {
            inputNodeId,
            nodes: [
              task(taskNodeId, [inputNodeId], {
                state: { type: "ref", nodeId: inputNodeId, path: [] },
              }) as Extract<PlanNode, { type: "task" }>,
              {
                ...validationCheck(checkNodeId),
                input: {
                  type: "ref",
                  nodeId: taskNodeId,
                  path: ["output"],
                },
                dependsOn: [taskNodeId],
              } as Extract<ValidationNode, { type: "validation.check" }>,
              validationGate(
                gateNodeId,
                checkNodeId,
                "repeat-postcondition",
                [taskNodeId, checkNodeId],
                { type: "ref", nodeId: taskNodeId, path: ["output"] },
              ),
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
      output: { type: "ref", nodeId: "repeat:1", path: ["output"] },
    };

    expect(() => validatePlan(valid)).not.toThrow();
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

  it("rejects a non-final repeat postcondition gate and out-of-scope check", () => {
    const repeat: Plan = {
      workflow: { id: "invalid-validated-repeat" },
      nodes: [
        validationCheck("outer-check"),
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: {},
          dependsOn: [],
          maximumIterations: 2,
          body: {
            inputNodeId: "repeat:1:input",
            nodes: [
              validationGate(
                "repeat:1/gate:1",
                "outer-check",
                "repeat-postcondition",
                ["outer-check"],
              ),
              task("repeat:1/after:1", ["repeat:1/gate:1"], {
                value: {
                  type: "ref",
                  nodeId: "repeat:1/gate:1",
                  path: ["value"],
                },
              }) as Extract<PlanNode, { type: "task" }>,
            ],
            output: {
              type: "ref",
              nodeId: "repeat:1/after:1",
              path: ["output"],
            },
            until: {
              type: "ref",
              nodeId: "repeat:1/gate:1",
              path: ["validation", "success"],
            },
          },
        },
      ],
      output: { type: "ref", nodeId: "repeat:1", path: ["output"] },
    };

    expect(() => validatePlan(repeat)).toThrow(/repeat body|final|scope/i);
  });

  it("rejects a fail gate used as a repeat condition", () => {
    const checkNodeId = "repeat:1/check:1";
    const gateNodeId = "repeat:1/gate:1";
    const source: Plan = {
      workflow: { id: "invalid-policy" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: {},
          dependsOn: [],
          maximumIterations: 1,
          body: {
            inputNodeId: "repeat:1:input",
            nodes: [
              validationCheck(checkNodeId),
              validationGate(gateNodeId, checkNodeId, "fail", [checkNodeId]),
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
      output: { type: "ref", nodeId: "repeat:1", path: ["output"] },
    };

    expect(() => validatePlan(source)).toThrow(/repeat.*postcondition|gate/i);
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

describe("EffectCompiler workflow compilation", () => {
  function executablePlan(): Plan {
    return plan([task("z"), task("a"), task("result", ["a", "z"])]);
  }

  it("creates one typed generated step plus the result step", () => {
    const compiled = new EffectCompiler().compileWorkflow(executablePlan(), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map(),
    });

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
    const compiled = new EffectCompiler().compileWorkflow(
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
    const schema: SeqlaneSchema = { parse: (value) => value };
    const compiled = new EffectCompiler().compileWorkflow(
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
              workspace: "shared" as const,
              input: schema,
              output: schema,
              goal: () => "a",
            },
          ],
          [
            "z",
            {
              id: "z",
              workspace: "shared" as const,
              input: schema,
              output: schema,
              goal: () => "z",
            },
          ],
          [
            "result",
            {
              id: "result",
              workspace: "shared" as const,
              input: schema,
              output: schema,
              goal: () => "result",
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
    const compiled = new EffectCompiler().compileWorkflow(
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
    const compiled = new EffectCompiler().compileWorkflow(executablePlan(), {
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
    const taskSchema: SeqlaneSchema = { parse: (value) => value };
    const taskDefinitions = new Map(
      ["a", "z", "result"].map((taskId) => [
        taskId,
        {
          id: taskId,
          workspace: "shared" as const,
          input: taskSchema,
          output: taskSchema,
          goal: () => taskId,
        },
      ]),
    );
    const compiled = new EffectCompiler().compileWorkflow(executablePlan(), {
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
    });

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

  function schema<T>(parse: (value: unknown) => T): SeqlaneSchema<T> {
    return { parse };
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
    const compiled = new EffectCompiler().compileWorkflow(
      plan([consumer, source]),
      {
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
      },
    );

    await executeSequentialProgram(compiled.program);

    expect(requests.map(({ input }) => input)).toEqual([
      { value: "from-input" },
      { value: "from-source" },
    ]);
    expect(compiled.context.results.has("source")).toBe(false);
  });

  it("fails before invoking an executor when task input validation fails", async () => {
    let calls = 0;
    const compiled = new EffectCompiler().compileWorkflow(plan([task("a")]), {
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
    const compiled = new EffectCompiler().compileWorkflow(plan([task("a")]), {
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
