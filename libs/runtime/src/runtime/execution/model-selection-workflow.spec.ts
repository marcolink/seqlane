// @test-scope ./model-preflight.ts
// @test-scope ./workflow-run.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../session/session-preflight.ts
// @test-scope ../../../../fixtures/src/model-selection-workflow.ts
import type {
  ModelRef,
  ModelSelection,
  SeqlaneEvent,
  TaskDefinition,
} from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { modelSelectionWorkflow } from "@seqlane/fixtures/model-selection-workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanCompiler } from "../compile/compile-plan.js";
import { preflightCompiledWorkflowModels } from "./model-preflight.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import type { SeqlaneExecutor } from "./executor.js";
import { runCompiledWorkflow } from "./workflow-run.js";

const availableModels: readonly ModelRef[] = [
  { provider: "openai", model: "gpt-5.6-sol" },
  { provider: "openai", model: "gpt-5.6-luna" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
];

const defaultSelection: ModelSelection = {
  model: { provider: "openai", model: "gpt-5.6-sol" },
  reasoning: "medium",
};

function createSession(
  executor: SeqlaneExecutor,
  selection: ModelSelection | undefined,
  forkSelections: ModelSelection[],
  id: string,
): ResolvedExecutorSession {
  return {
    key: Symbol(id),
    executor,
    ...(selection === undefined ? {} : { effectiveSelection: selection }),
    checkpoint: async () => "fixture-checkpoint",
    fork: async ({ effectiveSelection }) => {
      if (effectiveSelection !== undefined)
        forkSelections.push(effectiveSelection);
      return createSession(
        executor,
        effectiveSelection,
        forkSelections,
        `${id}:fork`,
      );
    },
  };
}

function selectionFor(
  provider: string,
  model: string,
  reasoning: ModelSelection["reasoning"],
): ModelSelection {
  return {
    model: { provider, model },
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

describe("model-selection fixture integration", () => {
  it("runs isolated, reused, and branched sessions with effective selections", async () => {
    const events: SeqlaneEvent[] = [];
    const forkSelections: ModelSelection[] = [];
    const executor: SeqlaneExecutor = {
      execute: async ({ input }) => ({
        label: (input as { readonly label: string }).label,
      }),
    };
    const built = buildWorkflow(modelSelectionWorkflow);
    const compiled = new PlanCompiler().compileWorkflow(built.plan, {
      createInvocationId: (nodeId) => nodeId,
      workflowInput: { label: "model-selection" },
      executors: new Map([["fixture-opencode", executor]]),
      sessionResolver: {
        modelCapabilities: {
          executor: "fixture-opencode",
          listModels: async () => availableModels,
          resolveDefaultModel: async () => defaultSelection,
        },
        resolve: async ({ invocationId, effectiveSelection }) =>
          createSession(
            executor,
            effectiveSelection,
            forkSelections,
            invocationId,
          ),
      },
      taskDefinitions: built.taskDefinitions,
      validatorDefinitions: built.validatorDefinitions,
      events: { emit: (event) => events.push(event) },
    });

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);
    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
    });

    const sourceSelection = selectionFor("openai", "gpt-5.6-luna", "high");
    const expectedSelections = new Map([
      [
        "model-selection.isolated:1",
        selectionFor("openai", "gpt-5.6-sol", "medium"),
      ],
      ["model-selection.source:1", sourceSelection],
      ["model-selection.reuse:1", sourceSelection],
      [
        "model-selection.branch:1",
        selectionFor("anthropic", "claude-sonnet-4-6", "low"),
      ],
      [
        "model-selection.child:1",
        selectionFor("openai", "gpt-5.6-sol", "minimal"),
      ],
    ]);

    expect(compiled.context.effectiveModelSelections).toEqual(
      expectedSelections,
    );
    expect(forkSelections).toEqual([
      expectedSelections.get("model-selection.branch:1"),
      expectedSelections.get("model-selection.child:1"),
    ]);

    const outputSelections = new Map(
      events
        .filter(
          (
            event,
          ): event is Extract<SeqlaneEvent, { type: "invocation.output" }> =>
            event.type === "invocation.output" && event.policy === "persistent",
        )
        .map((event) => [event.invocationId, event.metrics?.modelSelection]),
    );
    expect(outputSelections).toEqual(expectedSelections);
  });

  it("runs a legacy Plan without model fields using the executor default", async () => {
    const events: SeqlaneEvent[] = [];
    const task: TaskDefinition = {
      id: "legacy-task",
      input: z.unknown(),
      output: z.unknown(),
      execute: async ({ context }) =>
        context.runAgent({ goal: "run a legacy task" }),
    };
    const executor: SeqlaneExecutor = {
      execute: async () => ({ label: "legacy" }),
    };
    const compiled = new PlanCompiler().compileWorkflow(
      {
        workflow: { id: "legacy-model-plan" },
        nodes: [
          {
            type: "task",
            taskId: task.id,
            nodeId: "legacy-task:1",
            workspace: "shared",
            session: { type: "isolated" },
            input: {},
            dependsOn: [],
          },
        ],
        output: { type: "ref", nodeId: "legacy-task:1", path: [] },
      },
      {
        createInvocationId: (nodeId) => nodeId,
        executors: new Map([["fixture-opencode", executor]]),
        sessionResolver: {
          modelCapabilities: {
            executor: "fixture-opencode",
            listModels: async () => [defaultSelection.model],
            resolveDefaultModel: async () => defaultSelection,
          },
          resolve: async ({ effectiveSelection }) =>
            createSession(executor, effectiveSelection, [], "legacy"),
        },
        taskDefinitions: new Map([[task.id, task]]),
        events: { emit: (event) => events.push(event) },
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);
    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(compiled.plan.nodes[0]).not.toHaveProperty("session.model");
    expect(
      events.find(
        (event) =>
          event.type === "invocation.output" && event.policy === "persistent",
      ),
    ).toMatchObject({ metrics: { modelSelection: defaultSelection } });
  });
});
