// @test-scope ./effect-choice.ts
// @test-scope ./model-preflight.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../execution/executor.ts
import {
  defineTask,
  type ModelRef,
  type Plan,
  type TaskNode,
} from "@seqlane/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutorModelCapabilities, SeqlaneExecutor } from "./executor.js";
import { executeChoiceNodeEffect } from "./effect-choice.js";
import { preflightSelectedChoiceModel } from "./model-preflight.js";

const schema = z.object({ value: z.string() });

function task(nodeId: string, taskId: string, model: ModelRef): TaskNode {
  return {
    type: "task",
    taskId,
    nodeId,
    workspace: "shared",
    session: { type: "isolated", model: { model, reasoning: "high" } },
    input: { value: nodeId },
    dependsOn: [],
  };
}

describe("native choice model preflight", () => {
  it("validates and pins only the selected arm model before executing it", async () => {
    const selectedModel = { provider: "test", model: "selected" };
    const unselectedModel = { provider: "test", model: "unavailable" };
    const selectedTask = defineTask({
      id: "selected",
      input: schema,
      output: schema,
      execute: ({ input, context }) => context.runAgent({ goal: input.value }),
    });
    const unselectedTask = defineTask({
      id: "unselected",
      input: schema,
      output: schema,
      execute: ({ input, context }) => context.runAgent({ goal: input.value }),
    });
    let catalogCalls = 0;
    let observedSelection: unknown;
    const modelCapabilities: ExecutorModelCapabilities = {
      executor: "test-executor",
      listModels: async () => {
        catalogCalls += 1;
        return [selectedModel];
      },
      resolveDefaultModel: async () => ({ model: selectedModel }),
    };
    const executor: SeqlaneExecutor = {
      modelCapabilities,
      execute: async (request) => {
        observedSelection = request.modelSelection;
        return { value: "selected result" };
      },
    };
    const selected = task("choice:then", selectedTask.id, selectedModel);
    const unselected = task("choice:else", unselectedTask.id, unselectedModel);
    const plan: Plan = {
      workflow: { id: "choice-model" },
      nodes: [
        {
          type: "choice",
          nodeId: "choice",
          condition: { type: "ref", nodeId: "__seqlane_input", path: ["pick"] },
          then: selected,
          else: unselected,
          dependsOn: [],
        },
      ],
      output: null,
    };
    const compiled = new PlanCompiler().compileWorkflow(plan, {
      workflowInput: { pick: true },
      createInvocationId: (nodeId) => nodeId,
      executors: new Map([
        [selectedTask.id, executor],
        [unselectedTask.id, executor],
      ]),
      taskDefinitions: new Map([
        [selectedTask.id, selectedTask],
        [unselectedTask.id, unselectedTask],
      ]),
    });
    const choice = compiled.plan.nodes.find((node) => node.type === "choice");
    if (choice?.type !== "choice") throw new Error("Choice plan node missing");

    await Effect.runPromise(
      executeChoiceNodeEffect(
        compiled.context,
        choice,
        new AbortController().signal,
        (effect) => effect,
        undefined,
        (node) => preflightSelectedChoiceModel(compiled, node),
      ),
    );

    expect(catalogCalls).toBe(1);
    expect(observedSelection).toEqual({
      model: selectedModel,
      reasoning: "high",
    });
    expect(
      compiled.context.effectiveModelSelectionsByNode.get("choice:then"),
    ).toEqual({ model: selectedModel, reasoning: "high" });
    expect(
      compiled.context.effectiveModelSelectionsByNode.has("choice:else"),
    ).toBe(false);
  });
});
