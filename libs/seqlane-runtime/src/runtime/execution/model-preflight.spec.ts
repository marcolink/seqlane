// @test-scope ./model-preflight.ts
// @test-scope ./executor.ts
// @test-scope ./context.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../session/session-preflight.ts
import type {
  ModelRef,
  ModelSelection,
  Plan,
  PlanNode,
  RepeatNode,
  TaskDefinition,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanCompiler } from "../compile/compile-plan.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import {
  preflightCompiledWorkflowModels,
  UnavailableExecutorModelError,
} from "./model-preflight.js";
import type { ExecutorModelCapabilities, SeqlaneExecutor } from "./executor.js";

function task(
  nodeId: string,
  session?: Extract<PlanNode, { type: "task" }>["session"],
  dependsOn: readonly string[] = [],
): Extract<PlanNode, { type: "task" }> {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    session: { type: "isolated" },
    ...(session === undefined ? {} : { session }),
    input: {},
    dependsOn,
  };
}

function plan(nodes: readonly PlanNode[]): Plan {
  return {
    workflow: { id: "model-preflight" },
    nodes,
    output: null,
  };
}

function taskDefinition(id: string): TaskDefinition {
  const schema = z.unknown();
  return {
    id,
    input: schema,
    output: schema,
    execute: async ({ context }) => context.runAgent({ goal: "" }),
  };
}

function model(reference: string): ModelRef {
  const separator = reference.indexOf("/");
  return {
    provider: reference.slice(0, separator),
    model: reference.slice(separator + 1),
  };
}

function capabilities(
  available: ModelRef[],
  defaultSelection: ModelSelection,
  executor = "fake-executor",
): ExecutorModelCapabilities {
  return {
    executor,
    listModels: async () =>
      available.map(({ provider, model: id }) => ({ provider, model: id })),
    resolveDefaultModel: async () => defaultSelection,
  };
}

function fakeExecutor(
  modelCapabilities: ExecutorModelCapabilities,
  onExecute: () => void,
): SeqlaneExecutor {
  return {
    modelCapabilities,
    execute: async () => {
      onExecute();
      return {};
    },
  };
}

describe("executor model preflight", () => {
  it("uses task executor capabilities before resolver capabilities", async () => {
    const taskSelection = {
      model: model("task/task-model"),
      reasoning: "high" as const,
    };
    const resolverDefault = {
      model: model("resolver/resolver-model"),
      reasoning: "minimal" as const,
    };
    const taskExecutor = fakeExecutor(
      capabilities([taskSelection.model], taskSelection, "task-executor"),
      () => undefined,
    );
    const compiled = new PlanCompiler().compileWorkflow(
      plan([
        task("task-specific", { type: "isolated" }),
        task("resolver-managed"),
      ]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          ["task-specific", taskExecutor],
          ["unrelated", { execute: async () => ({}) }],
        ]),
        sessionResolver: {
          modelCapabilities: capabilities(
            [resolverDefault.model],
            resolverDefault,
            "resolver-executor",
          ),
          resolve: async () => ({
            key: Symbol("resolver-session"),
            executor: { execute: async () => ({}) },
          }),
        },
      },
    );

    await preflightCompiledWorkflowModels(compiled);

    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map<string, ModelSelection>([
        ["task-specific", taskSelection],
        ["resolver-managed", resolverDefault],
      ]),
    );
  });

  it("rejects an unavailable explicit model before session resolution or task execution", async () => {
    let sessionResolutions = 0;
    let executions = 0;
    const available = model("anthropic/claude-sonnet-4");
    const requested = model("openai/gpt-5");
    const executor = fakeExecutor(
      capabilities([available], { model: available }),
      () => {
        executions += 1;
      },
    );
    const compiled = new PlanCompiler().compileWorkflow(
      plan([
        task("unavailable", {
          type: "isolated",
          model: { model: requested, reasoning: "high" },
        }),
      ]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([["test-executor", executor]]),
        sessionResolver: {
          resolve: async () => {
            sessionResolutions += 1;
            return { key: Symbol("session"), executor };
          },
        },
      },
    );

    await expect(
      preflightCompiledWorkflowModels(compiled),
    ).rejects.toMatchObject({
      name: UnavailableExecutorModelError.name,
      executor: "fake-executor",
      message: expect.stringMatching(
        /openai\/gpt-5.*reasoning: high.*anthropic\/claude-sonnet-4/i,
      ),
    });
    expect(sessionResolutions).toBe(0);
    expect(executions).toBe(0);
  });

  it("records the executor default for a new session without a model", async () => {
    const defaultSelection = {
      model: model("openai/gpt-5-mini"),
      reasoning: "minimal" as const,
    };
    const executor = fakeExecutor(
      capabilities([defaultSelection.model], defaultSelection),
      () => undefined,
    );
    const compiled = new PlanCompiler().compileWorkflow(
      plan([task("legacy")]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([["test-executor", executor]]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);

    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map([["legacy", defaultSelection]]),
    );
  });

  it("stores the source default for model-less reuse and branch descendants", async () => {
    const defaultSelection = {
      model: model("openai/gpt-5-mini"),
      reasoning: "minimal" as const,
    };
    let defaultResolutions = 0;
    const executor = fakeExecutor(
      {
        ...capabilities([defaultSelection.model], defaultSelection),
        resolveDefaultModel: async () => {
          defaultResolutions += 1;
          return defaultSelection;
        },
      },
      () => undefined,
    );
    const compiled = new PlanCompiler().compileWorkflow(
      plan([
        task("source"),
        task("reuse", { type: "reuse", from: "source" }, ["source"]),
        task("branch", { type: "branch", from: "source" }, ["source"]),
        task("branch-reuse", { type: "reuse", from: "branch" }, ["branch"]),
      ]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([["test-executor", executor]]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);

    expect(defaultResolutions).toBe(1);
    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map([
        ["source", defaultSelection],
        ["reuse", defaultSelection],
        ["branch", defaultSelection],
        ["branch-reuse", defaultSelection],
      ]),
    );
  });

  it("preflights task-backed validation sessions and records their default", async () => {
    const defaultSelection = {
      model: model("anthropic/claude-sonnet-4"),
      reasoning: "high" as const,
    };
    const executor = fakeExecutor(
      capabilities([defaultSelection.model], defaultSelection),
      () => undefined,
    );
    const validation: Extract<PlanNode, { type: "validation.check" }> = {
      type: "validation.check",
      nodeId: "check",
      source: {
        type: "task",
        taskId: "evaluate",
        workspace: "shared",
      },
      input: {},
      dependsOn: [],
    };
    const compiled = new PlanCompiler().compileWorkflow(plan([validation]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([["evaluate", executor]]),
      taskDefinitions: new Map([["evaluate", taskDefinition("evaluate")]]),
    });

    await preflightCompiledWorkflowModels(compiled);

    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map([["check", defaultSelection]]),
    );
  });

  it("validates repeat-body models without recording static invocation keys", async () => {
    const requested = model("openai/gpt-5");
    let listed = 0;
    const executor = fakeExecutor(
      {
        ...capabilities([requested], { model: requested }),
        listModels: async () => {
          listed += 1;
          return [requested];
        },
      },
      () => undefined,
    );
    const repeatNodeId = "repeat";
    const bodyNodeId = "repeat/body";
    const repeat: RepeatNode = {
      type: "repeat",
      nodeId: repeatNodeId,
      input: {},
      dependsOn: [],
      maximumIterations: 2,
      body: {
        inputNodeId: "repeat/input",
        nodes: [
          task(bodyNodeId, {
            type: "isolated",
            model: { model: requested },
          }),
        ],
        output: { type: "ref", nodeId: bodyNodeId, path: [] },
        until: { type: "ref", nodeId: bodyNodeId, path: ["passed"] },
      },
    };
    const compiled = new PlanCompiler().compileWorkflow(plan([repeat]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([[bodyNodeId, executor]]),
    });

    await preflightCompiledWorkflowModels(compiled);

    expect(listed).toBe(1);
    expect(compiled.context.effectiveModelSelections).toEqual(new Map());
  });

  it("accepts a legacy plan when the executor has no model capability", async () => {
    const compiled = new PlanCompiler().compileWorkflow(
      plan([task("legacy")]),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map(),
      },
    );

    await expect(
      preflightCompiledWorkflowModels(compiled),
    ).resolves.toBeUndefined();
    expect(compiled.context.effectiveModelSelections).toEqual(new Map());
  });
});
