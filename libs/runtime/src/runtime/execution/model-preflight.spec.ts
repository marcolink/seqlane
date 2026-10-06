// @test-scope ./model-preflight.ts
// @test-scope ./executor.ts
// @test-scope ./context.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../session/session-preflight.ts
import type {
  ModelRef,
  ModelSelection,
  ChoiceNode,
  Plan,
  PlanNode,
  RepeatNode,
  TaskDefinition,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanCompiler } from "../compile/compile-plan.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import {
  MissingWorkflowModelSelectionError,
  preflightCompiledWorkflowModels,
  preflightSelectedChoiceModel,
  requireStandaloneModelSelection,
  UnavailableExecutorModelError,
  validateStandaloneModelAvailability,
} from "./model-preflight.js";
import type { ExecutorModelCapabilities, SeqlaneExecutor } from "./executor.js";

function task(
  nodeId: string,
  session?: Extract<PlanNode, { type: "task" }>["session"],
  dependsOn: readonly string[] = [],
  input: Extract<PlanNode, { type: "task" }>["input"] = {},
): Extract<PlanNode, { type: "task" }> {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    session: { type: "isolated" },
    ...(session === undefined ? {} : { session }),
    input,
    dependsOn,
  };
}

function plan(
  nodes: readonly PlanNode[],
  workflowModel?: ModelSelection,
): Plan {
  return {
    workflow: {
      id: "model-preflight",
      ...(workflowModel === undefined ? {} : { model: workflowModel }),
    },
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
  it("checks only the selected choice arm's model", async () => {
    const available = { model: model("openai/available") };
    const unavailable = { model: model("openai/unavailable") };
    const listModels = vi.fn(async () => [available.model]);
    const executor = fakeExecutor(
      { ...capabilities([available.model], available), listModels },
      () => undefined,
    );
    const thenArm = task("choice:1:then", {
      type: "isolated",
      model: available,
    });
    const elseArm = task("choice:1:else", {
      type: "isolated",
      model: unavailable,
    });
    const choice: ChoiceNode = {
      type: "choice",
      nodeId: "choice:1",
      condition: { type: "ref", nodeId: "__seqlane_input", path: ["pick"] },
      then: thenArm,
      else: elseArm,
      dependsOn: [],
    };
    const compiled = new PlanCompiler().compileWorkflow(plan([choice]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        ["choice:1:then", executor],
        ["choice:1:else", executor],
      ]),
    });
    await preflightCompiledWorkflowModels(compiled);
    expect(listModels).not.toHaveBeenCalled();
    await preflightSelectedChoiceModel(compiled, thenArm);
    expect(
      compiled.context.effectiveModelSelectionsByNode.get("choice:1:then"),
    ).toEqual(available);
    expect(listModels).toHaveBeenCalledTimes(1);
    await expect(
      preflightSelectedChoiceModel(compiled, elseArm),
    ).rejects.toBeInstanceOf(UnavailableExecutorModelError);
  });

  it("uses a workflow model default without consulting an adapter default", async () => {
    const selection = { model: model("openai/gpt-5.6-sol") };
    const resolveDefaultModel = vi.fn(async () => selection);
    const compiled = new PlanCompiler().compileWorkflow(
      plan([task("agent")], selection),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          [
            "agent",
            fakeExecutor(
              {
                ...capabilities([selection.model], selection),
                resolveDefaultModel,
              },
              () => undefined,
            ),
          ],
        ]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);

    expect(resolveDefaultModel).not.toHaveBeenCalled();
    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map([["agent", selection]]),
    );
  });

  it("requires an authored model for a standalone agent invocation", () => {
    expect(() =>
      requireStandaloneModelSelection({ nodeId: "agent", taskId: "agent" }),
    ).toThrow(MissingWorkflowModelSelectionError);
  });

  it("checks a demanded standalone model only when discovery is available", async () => {
    const requested = { model: model("openai/gpt-5.6-sol") };
    await expect(
      validateStandaloneModelAvailability(requested, undefined),
    ).resolves.toBeUndefined();
    await expect(
      validateStandaloneModelAvailability(
        requested,
        capabilities([model("anthropic/claude-sonnet-4")], requested),
      ),
    ).rejects.toBeInstanceOf(UnavailableExecutorModelError);
  });

  it("rejects a demanded model setting that the adapter does not support", async () => {
    const requested = {
      model: model("openai/gpt-5.6-sol"),
      reasoning: "high" as const,
    };
    const validateModelSelection = vi.fn(async () => {
      throw new Error("unsupported reasoning");
    });

    await expect(
      validateStandaloneModelAvailability(requested, {
        ...capabilities([requested.model], requested),
        validateModelSelection,
      }),
    ).rejects.toThrow("unsupported reasoning");
    expect(validateModelSelection).toHaveBeenCalledWith(requested);
  });

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

  it("keeps a branch pinned to its source instead of using the workflow default", async () => {
    const sourceSelection = {
      model: model("openai/gpt-5.6-sol"),
      reasoning: "high" as const,
    };
    const workflowSelection = {
      model: model("anthropic/claude-sonnet-4"),
      reasoning: "minimal" as const,
    };
    const compiled = new PlanCompiler().compileWorkflow(
      plan(
        [
          task("source", { type: "isolated", model: sourceSelection }),
          task("branch", { type: "branch", from: "source" }, ["source"]),
        ],
        workflowSelection,
      ),
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([
          [
            "source",
            fakeExecutor(
              capabilities(
                [sourceSelection.model, workflowSelection.model],
                sourceSelection,
              ),
              () => undefined,
            ),
          ],
          [
            "branch",
            fakeExecutor(
              capabilities(
                [sourceSelection.model, workflowSelection.model],
                sourceSelection,
              ),
              () => undefined,
            ),
          ],
        ]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);

    expect(compiled.context.effectiveModelSelections).toEqual(
      new Map([
        ["source", sourceSelection],
        ["branch", sourceSelection],
      ]),
    );
  });

  it("does not preflight a sessionless task-backed validation source", async () => {
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

    expect(compiled.context.effectiveModelSelections).toEqual(new Map());
  });

  it("validates repeat-attempt models without recording static invocation keys", async () => {
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
    const attemptNodeId = "repeat/attempt";
    const repeat: RepeatNode = {
      type: "repeat",
      nodeId: repeatNodeId,
      input: {},
      dependsOn: [],
      maximumIterations: 2,
      attempt: task(
        attemptNodeId,
        {
          type: "isolated",
          model: { model: requested },
        },
        [],
        { type: "ref", nodeId: "repeat:input", path: [] },
      ),
      until: { type: "ref", nodeId: attemptNodeId, path: ["output", "passed"] },
    };
    const compiled = new PlanCompiler().compileWorkflow(plan([repeat]), {
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([[attemptNodeId, executor]]),
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
