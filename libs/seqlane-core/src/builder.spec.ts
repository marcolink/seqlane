// @test-scope ./builder.ts
// @test-scope ./dsl.ts

import { describe, expect, it } from "vitest";
import type { SeqlaneSchema } from "./contracts.js";
import {
  branch,
  createFlow,
  defineTask,
  defineWorkflow,
  isolated,
  reuse,
} from "./dsl.js";
import { buildWorkflow } from "./builder.js";
import { openai } from "./models/index.js";

const schema = <T>(): SeqlaneSchema<T> => ({
  parse(value: unknown): T {
    return value as T;
  },
});

describe("buildWorkflow", () => {
  it("nests model selection under an isolated session", () => {
    const task = defineTask({
      id: "selected-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "selected-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) =>
        run(task, {
          input,
          session: isolated({
            model: openai("gpt-5.6-luna"),
            reasoning: "high",
          }),
        }).output,
    });

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
    const task = defineTask({
      id: "branched-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "branched-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) => {
        const source = run(task, { input });
        return run(task, {
          input,
          session: branch(source.session, {
            model: openai("gpt-5.6-sol"),
            reasoning: "low",
          }),
        }).output;
      },
    });

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
    const task = defineTask({
      id: "reused-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "reused-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) => {
        const source = run(task, { input });
        return run(task, {
          input,
          // @ts-expect-error Reuse sessions inherit their source model.
          session: reuse(source.session, { model: openai("gpt-5.6-sol") }),
        }).output;
      },
    });

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      session: { type: "reuse", from: "reused-model:1" },
    });
  });

  it("does not allow model configuration directly on a task invocation", () => {
    const task = defineTask({
      id: "task-level-model",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "task-level-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) =>
        run(task, {
          input,
          // @ts-expect-error Model selection belongs under session.
          model: openai("gpt-5.6-luna"),
        }).output,
    });

    expect(buildWorkflow(workflow).plan.nodes[0]).not.toHaveProperty("model");
  });

  it("carries session model selection into repeat body task nodes", () => {
    const task = defineTask({
      id: "repeat-selected-model",
      input: schema<{ readonly complete: boolean }>(),
      output: schema<{ readonly complete: boolean }>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "repeat-selected-model-workflow",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
      build: ({ repeat }) =>
        repeat({
          initial: { complete: false },
          body: ({ input, task: runTask }) =>
            runTask(task, {
              input,
              session: isolated({ model: openai("gpt-5.6-sol") }),
            }).output,
          until: ({ output }) => output.complete,
          maximumIterations: 1,
        }).output,
    });

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      body: {
        nodes: [
          {
            session: {
              type: "isolated",
              model: {
                model: { provider: "openai", model: "gpt-5.6-sol" },
              },
            },
          },
        ],
      },
    });
  });

  it("defaults omitted workspace policy to exclusive in the Plan", () => {
    const task = defineTask({
      id: "default-workspace-policy",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "default-workspace-policy-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) => run(task, { input }).output,
    });

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      workspace: "exclusive",
      session: { type: "isolated" },
    });
  });

  it("serializes typed reuse and branch checkpoint selections", () => {
    const task = defineTask({
      id: "checkpointed",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      goal: () => "Complete work",
    });
    const workflow = defineWorkflow({
      id: "checkpointed-workflow",
      input: schema<Record<never, never>>(),
      output: schema<Record<never, never>>(),
      build: ({ input, run }) => {
        const source = run(task, { input });
        run(task, { input, session: branch(source.session) });
        return run(task, { input, session: reuse(source.session) }).output;
      },
    });

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
    const inspect = defineTask({
      id: "workspace-inspect",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly summary: string }>(),
      workspace: "shared",
      goal: ({ repository }) => repository,
    });
    const workflow = defineWorkflow({
      id: "workspace-capability",
      input: schema<{ readonly repository: string }>(),
      output: schema<{ readonly summary: string }>(),
      build: ({ input, run }) => run(inspect, { input }).output,
    });

    expect(buildWorkflow(workflow).plan.nodes[0]).toMatchObject({
      taskId: "workspace-inspect",
      workspace: "shared",
    });
  });

  it("adds one explicit dependency for nested data from one producer", () => {
    const produce = defineTask({
      id: "produce",
      workspace: "shared",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly first: string; readonly second: string }>(),
      goal: ({ request }) => request,
    });
    const consume = defineTask({
      id: "consume",
      workspace: "shared",
      input: schema<{ readonly values: readonly string[] }>(),
      output: schema<{ readonly summary: string }>(),
      goal: ({ values }) => values.join(", "),
    });
    const workflow = defineWorkflow({
      id: "nested-dataflow",
      input: schema<{ readonly request: string }>(),
      output: schema<{ readonly summary: string }>(),
      build: ({ input, run }) => {
        const produced = run(produce, { input });
        return run(consume, {
          input: {
            values: [produced.output.first, produced.output.second],
          },
        }).output;
      },
    });

    const built = buildWorkflow(workflow);

    expect(built.plan.nodes[1]).toMatchObject({
      taskId: "consume",
      dependsOn: ["produce:1"],
    });
  });

  it("adds an order-only dependency without passing task data", () => {
    const prepare = defineTask({
      id: "prepare",
      workspace: "shared",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly ready: boolean }>(),
      goal: ({ value }) => value,
    });
    const publish = defineTask({
      id: "publish",
      workspace: "shared",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly published: boolean }>(),
      goal: ({ value }) => value,
    });
    const workflow = defineWorkflow({
      id: "order-only-dependency",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly published: boolean }>(),
      build: ({ run }) => {
        const prepared = run(prepare, { input: { value: "prepare" } });
        return run(publish, {
          input: { value: "publish" },
          dependsOn: [prepared],
        }).output;
      },
    });

    expect(buildWorkflow(workflow).plan.nodes[1]).toMatchObject({
      taskId: "publish",
      dependsOn: ["prepare:1"],
    });
  });

  it("adds Flow order-only dependencies from prior handles", () => {
    const prepare = defineTask({
      id: "flow-prepare",
      workspace: "shared",
      input: schema<{ readonly value: string }>(),
      output: schema<{ readonly ready: boolean }>(),
      goal: ({ value }) => value,
    });
    const publish = defineTask({
      id: "flow-publish",
      workspace: "shared",
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

  it("adds an order-only dependency inside a repeat body", () => {
    const prepare = defineTask({
      id: "repeat-prepare",
      workspace: "shared",
      input: schema<{ readonly complete: boolean }>(),
      output: schema<{ readonly complete: boolean }>(),
      goal: () => "prepare",
    });
    const publish = defineTask({
      id: "repeat-publish",
      workspace: "shared",
      input: schema<{ readonly complete: boolean }>(),
      output: schema<{ readonly complete: boolean }>(),
      goal: () => "publish",
    });
    const workflow = defineWorkflow({
      id: "repeat-order-only-dependency",
      input: schema<Record<never, never>>(),
      output: schema<{ readonly complete: boolean }>(),
      build: ({ repeat }) =>
        repeat({
          initial: { complete: false },
          body: ({ input, task }) => {
            const prepared = task(prepare, { input });
            return task(publish, {
              input: { complete: true },
              dependsOn: [prepared],
            }).output;
          },
          until: ({ output }) => output.complete,
          maximumIterations: 1,
        }).output,
    });

    const repeat = buildWorkflow(workflow).plan.nodes[0];

    expect(repeat).toMatchObject({
      type: "repeat",
      body: {
        nodes: [
          {
            nodeId: "repeat:1/repeat-prepare:1",
            dependsOn: ["repeat:1:input"],
          },
          {
            nodeId: "repeat:1/repeat-publish:1",
            dependsOn: ["repeat:1/repeat-prepare:1"],
          },
        ],
      },
    });
  });
});
