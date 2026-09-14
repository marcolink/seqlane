// @test-scope ./builder.ts
// @test-scope ./dsl.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  branch,
  createFlow,
  defineAgentTask,
  defineTask,
  defineValidator,
  isolated,
  reuse,
} from "./dsl.js";
import { buildWorkflow } from "./builder.js";
import { openai } from "./models/index.js";

const schema = <T>() => z.custom<T>(() => true);

describe("buildWorkflow", () => {
  it("rejects malformed task behavior when a workflow is built", () => {
    const malformedTask = {
      id: "mixed-task-behavior",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    };
    const workflow = createFlow({
      id: "mixed-task-behavior-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      // @ts-expect-error A task must define execute.
      .task("malformed", malformedTask, ({ input }) => input)
      .output(({ tasks }) => tasks.malformed.output)
      .define();

    expect(() => buildWorkflow(workflow)).toThrow();
  });

  it("nests model selection under an isolated session", () => {
    const task = defineAgentTask({
      id: "selected-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "selected-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("selected", task, ({ input }) => input, {
        session: isolated({
          model: openai("gpt-5.6-luna"),
          reasoning: "high",
        }),
      })
      .output(({ tasks }) => tasks.selected.output)
      .define();

    const plan = buildWorkflow(workflow).plan;

    expect(plan.nodes[0]).toMatchObject({
      session: {
        type: "isolated",
        model: {
          model: { provider: "openai", model: "gpt-5.6-luna" },
          reasoning: "high",
        },
      },
    });
    expect(plan.nodes[0]).not.toHaveProperty("model");
    expect(plan.nodes[0]).not.toHaveProperty("reasoning");
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("allows a model only on a branched session", () => {
    const task = defineAgentTask({
      id: "branched-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "branched-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("source", task, ({ input }) => input, { session: isolated() })
      .task("branch", task, ({ input }) => input, {
        session: ({ tasks }) =>
          branch(tasks.source.session, {
            model: openai("gpt-5.6-sol"),
            reasoning: "low",
          }),
      })
      .output(({ tasks }) => tasks.branch.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      session: {
        type: "branch",
        model: {
          model: { provider: "openai", model: "gpt-5.6-sol" },
          reasoning: "low",
        },
      },
    });
  });

  it("does not allow model configuration on reuse", () => {
    const task = defineAgentTask({
      id: "reused-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "reused-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("source", task, ({ input }) => input, { session: isolated() })
      .task("reuse", task, ({ input }) => input, {
        session: ({ tasks }) =>
          // @ts-expect-error Reuse sessions inherit their source model.
          reuse(tasks.source.session, { model: openai("gpt-5.6-sol") }),
      })
      .output(({ tasks }) => tasks.reuse.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      session: { type: "reuse", from: "reused-model:1" },
    });
  });

  it("does not allow model configuration directly on a task invocation", () => {
    const task = defineAgentTask({
      id: "task-level-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "task-level-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("task", task, ({ input }) => input, { session: isolated() })
      .output(({ tasks }) => tasks.task.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[0]).not.toHaveProperty("model");
  });

  it("carries session model selection into a repeated task attempt", () => {
    const task = defineAgentTask({
      id: "repeat-selected-model",
      input: schema<{ readonly complete: boolean }>(),
      output: schema<{ readonly complete: boolean }>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "repeat-selected-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
    })
      .task("loop", task, () => ({ complete: false }), {
        session: isolated({ model: openai("gpt-5.6-sol") }),
      })
      .until(({ result }) => result.complete, { maxIterations: 1 })
      .output(({ tasks }) => tasks.loop.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      attempt: {
        session: {
          type: "isolated",
          model: {
            model: { provider: "openai", model: "gpt-5.6-sol" },
          },
        },
      },
    });
  });

  it("carries task output validation into every repeated attempt", () => {
    const task = defineTask({
      id: "repeat-validated-task",
      input: schema<{ readonly done: boolean }>(),
      output: schema<{ readonly done: boolean }>(),
      execute: async ({ input }) => input,
    });
    const validator = defineValidator({
      id: "repeat-output-validator",
      input: schema<{ readonly done: boolean }>(),
      validate: () => ({ success: true as const }),
    });
    const workflow = createFlow({
      id: "repeat-validated-workflow",
      input: schema<{ readonly done: boolean }>(),
      output: schema<{ readonly done: boolean }>(),
    })
      .task("loop", task, ({ input }) => input, {
        validateOutput: validator,
      })
      .until(({ result }) => result.done, { maxIterations: 1 })
      .output(({ tasks }) => tasks.loop.output)
      .define();

    const built = buildWorkflow(workflow);
    expect(built.plan.nodes[0]).toMatchObject({
      type: "repeat",
      validation: {
        source: {
          type: "mechanical",
          validatorId: validator.id,
        },
      },
    });
    expect(built.validatorDefinitions.get(validator.id)).toBe(validator);
  });

  it("carries explicit and session dependencies into the attempt node", () => {
    const task = defineTask({
      id: "repeat-dependency",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
      execute: async () => ({ complete: true }),
    });
    const workflow = createFlow({
      id: "repeat-dependency-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
    })
      .task("prepare", task, () => ({}), { session: isolated() })
      .task("loop", task, () => ({}), {
        dependsOn: ["prepare"],
        session: ({ tasks }) => reuse(tasks.prepare.session),
      })
      .until(({ result }) => result.complete, { maxIterations: 1 })
      .output(({ tasks }) => tasks.loop.output)
      .define();

    const repeat = buildWorkflow(workflow).plan.nodes[1];
    expect(repeat).toMatchObject({
      dependsOn: ["repeat-dependency:1"],
      attempt: {
        dependsOn: ["repeat-dependency:1"],
      },
    });
  });

  it("serializes prior task handles in repeat bindings and dependencies", () => {
    const task = defineTask({
      id: "repeat-prior-binding",
      input: schema<{ readonly value: boolean }>(),
      output: schema<{ readonly done: boolean }>(),
      execute: async () => ({ done: true }),
    });
    const workflow = createFlow({
      id: "repeat-prior-binding-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly done: boolean }>(),
    })
      .task("prepare", task, () => ({ value: true }))
      .task("loop", task, () => ({ value: false }))
      .until(({ tasks }) => tasks.prepare.output.done, {
        maxIterations: 2,
        nextInput: ({ tasks }) => ({ value: tasks.prepare.output.done }),
      })
      .output(({ tasks }) => tasks.loop.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      type: "repeat",
      dependsOn: ["repeat-prior-binding:1"],
      until: {
        type: "ref",
        nodeId: "repeat-prior-binding:1",
        path: ["output", "done"],
      },
      nextInput: {
        value: {
          type: "ref",
          nodeId: "repeat-prior-binding:1",
          path: ["output", "done"],
        },
      },
    });
  });

  it("defaults omitted workspace policy to exclusive in the Plan", () => {
    const task = defineAgentTask({
      id: "default-workspace-policy",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "default-workspace-policy-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("task", task, ({ input }) => input)
      .output(({ tasks }) => tasks.task.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      workspace: "exclusive",
    });
  });

  it("lowers local tasks without sessions and keeps definitions out of the Plan", () => {
    const local = defineTask({
      id: "local-status",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly clean: boolean }>(),
      execute: async () => ({ clean: true }),
    });
    const workflow = createFlow({
      id: "local-status-workflow",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly clean: boolean }>(),
    })
      .task("local", local, ({ input }) => input)
      .output(({ tasks }) => tasks.local.output)
      .define();

    const built = buildWorkflow(workflow);

    expect(built.plan.nodes).toEqual([
      {
        type: "task",
        taskId: "local-status",
        nodeId: "local-status:1",
        workspace: "exclusive",
        input: {
          type: "ref",
          nodeId: "__seqlane_input",
          path: [],
        },
        dependsOn: [],
      },
    ]);
    expect(built.taskDefinitions.get(local.id)).toBe(local);
    expect(JSON.stringify(built.plan)).not.toContain("execute");
    expect(JSON.stringify(built.plan)).not.toContain("repository");
  });

  it("carries local task execution through repeated attempts", () => {
    const local = defineTask({
      id: "local-repeat",
      input: schema<{ readonly complete: boolean }>(),
      output: schema<{ readonly complete: boolean }>(),
      execute: async ({ input }) => input,
    });
    const workflow = createFlow({
      id: "local-repeat-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
    })
      .task("loop", local, () => ({ complete: false }))
      .until(({ result }) => result.complete, { maxIterations: 1 })
      .output(({ tasks }) => tasks.loop.output)
      .define();

    const built = buildWorkflow(workflow);
    const repeat = built.plan.nodes[0];

    expect(repeat).toMatchObject({
      type: "repeat",
      attempt: {
        taskId: "local-repeat",
      },
    });
    expect(
      (repeat as Extract<typeof repeat, { type: "repeat" }>).attempt,
    ).not.toHaveProperty("session");
    expect(built.taskDefinitions.get(local.id)).toBe(local);
  });

  it("serializes typed reuse and branch checkpoint selections", () => {
    const task = defineAgentTask({
      id: "checkpointed",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = createFlow({
      id: "checkpointed-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
    })
      .task("source", task, ({ input }) => input, { session: isolated() })
      .task("branch", task, ({ input }) => input, {
        session: ({ tasks }) => branch(tasks.source.session),
      })
      .task("reuse", task, ({ input }) => input, {
        session: ({ tasks }) => reuse(tasks.source.session),
      })
      .output(({ tasks }) => tasks.reuse.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes).toMatchObject([
      { nodeId: "checkpointed:1", session: { type: "isolated" } },
      {
        nodeId: "checkpointed:2",
        session: { type: "branch", from: "checkpointed:1" },
        dependsOn: ["checkpointed:1"],
      },
      {
        nodeId: "checkpointed:3",
        session: { type: "reuse", from: "checkpointed:1" },
        dependsOn: ["checkpointed:1"],
      },
    ]);
  });

  it("serializes each task workspace capability into the Plan", () => {
    const inspect = defineAgentTask({
      id: "workspace-inspect",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly summary: string }>(),
      goal: ({ repository }) => repository,
    });
    const workflow = createFlow({
      id: "workspace-capability",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly summary: string }>(),
    })
      .task("inspect", inspect, ({ input }) => input)
      .output(({ tasks }) => tasks.inspect.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      taskId: "workspace-inspect",
    });
  });

  it("adds one explicit dependency for nested data from one producer", () => {
    const produce = defineAgentTask({
      id: "produce",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly first: string; readonly second: string }>(),
      goal: ({ request }) => request,
    });
    const consume = defineAgentTask({
      id: "consume",
      input: schema<{ readonly values: readonly string[] }>(),
      output: schema<{ readonly summary: string }>(),
      goal: ({ values }) => values.join(", "),
    });
    const workflow = createFlow({
      id: "nested-dataflow",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly summary: string }>(),
    })
      .task("produce", produce, ({ input }) => input)
      .task("consume", consume, ({ tasks }) => ({
        values: [tasks.produce.output.first, tasks.produce.output.second],
      }))
      .output(({ tasks }) => tasks.consume.output)
      .define();

    const built = buildWorkflow(workflow);

    expect(built.plan.nodes[1]).toMatchObject({
      taskId: "consume",
      dependsOn: ["produce:1"],
    });
  });

  it("adds an order-only dependency without passing task data", () => {
    const prepare = defineAgentTask({
      id: "prepare",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly ready: boolean }>(),
      goal: ({ value }) => value,
    });
    const publish = defineAgentTask({
      id: "publish",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly published: boolean }>(),
      goal: ({ value }) => value,
    });
    const workflow = createFlow({
      id: "order-only-dependency",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly published: boolean }>(),
    })
      .task("prepare", prepare, () => ({ value: "prepare" }))
      .task("publish", publish, () => ({ value: "publish" }), {
        dependsOn: ["prepare"],
      })
      .output(({ tasks }) => tasks.publish.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      taskId: "publish",
      dependsOn: ["prepare:1"],
    });
  });

  it("adds Flow order-only dependencies from prior handles", () => {
    const prepare = defineAgentTask({
      id: "flow-prepare",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly ready: boolean }>(),
      goal: ({ value }) => value,
    });
    const publish = defineAgentTask({
      id: "flow-publish",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly published: boolean }>(),
      goal: ({ value }) => value,
    });
    const workflow = createFlow({
      id: "flow-order-only-dependency",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly published: boolean }>(),
    })
      .task("prepare", prepare, () => ({ value: "prepare" }))
      .task("publish", publish, () => ({ value: "publish" }), {
        dependsOn: ["prepare"],
      })
      .output(({ tasks }) => tasks.publish.output)
      .define();

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      taskId: "flow-publish",
      dependsOn: ["flow-prepare:1"],
    });
  });
});
