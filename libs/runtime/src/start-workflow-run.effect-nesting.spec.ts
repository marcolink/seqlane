// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/execution/effect-plan.ts
// @test-scope ./runtime/execution/effect-choice.ts
// @test-scope ./runtime/execution/effect-repeat.ts
// @test-scope ./runtime/execution/nested-workflow.ts
// @test-scope ./runtime/validation/output-validation-effect.ts
// @test-scope ./runtime/execution/program.ts
// @test-scope ./runtime/execution/run-sequential-graph.ts
// @test-scope ./runtime/invocation/invocation-execution.ts
// @test-scope ./runtime/invocation/joint-admission.ts
// @test-scope ./runtime/invocation/task-admission.ts
// @test-scope ./runtime/compile/compile-node-step.ts
// @test-scope ./runtime/session/session-lock.ts
// @test-scope ./runtime/workspace/workspace-lock.ts
// @test-scope ./runtime/workspace/workspace-resources.ts
// @test-scope ./runner/profile/runtime-profile.ts
// @test-scope ../../core/src/plan-types.ts
import {
  buildWorkflow,
  createFlow,
  defineTask,
  MAX_REPEAT_BODY_EXECUTIONS,
  planSchema,
  RunRepeatLimitExceededError,
  validationResultSchema,
  type SeqlaneEvent,
  type JsonValue,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";
import { createEffectPlanProgram } from "./runtime/execution/effect-plan.js";

const valueSchema = z.object({ value: z.string() });
const doneSchema = z.object({ done: z.string() });
const booleanDoneSchema = z.object({ done: z.boolean() });

function deferred<A = void>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventSink() {
  const events: SeqlaneEvent[] = [];
  const listeners = new Set<(event: SeqlaneEvent) => void>();
  return {
    events,
    sink: {
      emit(event: SeqlaneEvent) {
        events.push(event);
        for (const listener of listeners) listener(event);
      },
    },
    waitFor(predicate: (events: readonly SeqlaneEvent[]) => boolean) {
      if (predicate(events)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (): void => {
          if (!predicate(events)) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
  };
}

async function settleBeforeTimeout<A>(promise: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Nested caller fixture did not reach its barrier"),
            ),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function task(
  id: string,
  execute: (input: {
    readonly value: string;
  }) => Promise<{ readonly value: string }> | { readonly value: string },
) {
  return defineTask({
    id,
    input: valueSchema,
    output: valueSchema,
    execute: async ({ input }) => execute(input),
  });
}

function taskFlow(
  id: string,
  runnable: ReturnType<typeof task>,
  workspace: "shared" | "exclusive" = "exclusive",
) {
  return createFlow({ id, input: valueSchema, output: valueSchema })
    .task("work", runnable, ({ input }) => input, { workspace })
    .output(({ tasks }) => tasks.work.output)
    .define();
}

function runWithResourceKeys(
  workflow: ReturnType<typeof buildWorkflow>,
  input: JsonValue,
  events: ReturnType<typeof eventSink>["sink"],
  resourceKeyForId: (id: string) => string,
) {
  return startWorkflowRun(
    { workflow, input, events },
    {
      program: (context) =>
        createEffectPlanProgram({
          ...context,
          resolveExecution: async (signal) => {
            const execution = await context.resolveExecution(signal);
            const workspaceResources = new Map(execution.workspaceResources);
            for (const id of [
              ...workflow.taskDefinitions.keys(),
              ...workflow.workflowDefinitions.keys(),
            ]) {
              workspaceResources.set(id, { key: resourceKeyForId(id) });
            }
            return { ...execution, workspaceResources };
          },
        }),
    },
  );
}

function terminalInvocations(events: readonly SeqlaneEvent[]) {
  return events.filter(
    (event) =>
      event.type === "invocation.succeeded" ||
      event.type === "invocation.failed" ||
      event.type === "invocation.cancelled",
  );
}

describe("startWorkflowRun Effect nested execution", () => {
  it("runs only the selected native choice arm", async () => {
    const calls: string[] = [];
    const chosenTask = task("effect-choice-selected", ({ value }) => {
      calls.push("selected");
      return { value: `${value}/selected` };
    });
    const skippedTask = task("effect-choice-skipped", ({ value }) => {
      calls.push("skipped");
      return { value: `${value}/skipped` };
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "effect-choice-root",
        input: z.object({ value: z.string(), choose: z.boolean() }),
        output: valueSchema,
      })
        .when(({ input }) => input.choose)
        .task("selected", chosenTask, ({ input }) => ({ value: input.value }))
        .otherwise(skippedTask, ({ input }) => ({ value: input.value }))
        .output(({ tasks }) => tasks.selected.output)
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      {
        workflow,
        input: { value: "start", choose: true },
        events: sink,
      },
      { program: createEffectPlanProgram },
    );

    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "start/selected" },
    });
    expect(calls).toEqual(["selected"]);
    const skippedCreated = events.find(
      (event) =>
        event.type === "invocation.created" && event.label === skippedTask.id,
    );
    expect(skippedCreated?.type).toBe("invocation.created");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.skipped",
        invocationId:
          skippedCreated?.type === "invocation.created"
            ? skippedCreated.invocationId
            : undefined,
      }),
    );
  });

  it("runs bounded native repeat attempts with next-input binding", async () => {
    let attempts = 0;
    const repeatOutputSchema = z.object({
      value: z.string(),
      done: z.boolean(),
    });
    const attemptTask = defineTask({
      id: "effect-repeat-attempt",
      input: valueSchema,
      output: repeatOutputSchema,
      execute: async ({ input }) => {
        attempts += 1;
        return { value: `${input.value}${attempts}`, done: attempts === 3 };
      },
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "effect-repeat-root",
        input: valueSchema,
        output: repeatOutputSchema,
      })
        .task("attempt", attemptTask, ({ input }) => input)
        .until(({ result }) => result.done, {
          maxIterations: 4,
          nextInput: ({ result }) => ({ value: result.value }),
        })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow, input: { value: "v" }, events: sink },
      { program: createEffectPlanProgram },
    );

    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "v123", done: true },
    });
    expect(attempts).toBe(3);
    expect(
      events.filter(
        (event) =>
          event.type === "invocation.created" && event.iteration !== undefined,
      ),
    ).toHaveLength(3);
  });

  it("runs three nested levels with contained invocation identities and output", async () => {
    const leafTask = task("nested-three-level-leaf", ({ value }) => ({
      value: `${value}/leaf`,
    }));
    const leaf = taskFlow("nested-three-level-leaf-flow", leafTask);
    const middle = createFlow({
      id: "nested-three-level-middle",
      input: valueSchema,
      output: valueSchema,
    })
      .task("leaf", leaf, ({ input }) => input)
      .output(({ tasks }) => tasks.leaf.output)
      .define();
    const root = buildWorkflow(
      createFlow({
        id: "nested-three-level-root",
        input: valueSchema,
        output: valueSchema,
      })
        .task("middle", middle, ({ input }) => input)
        .output(({ tasks }) => tasks.middle.output)
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow: root, input: { value: "start" }, events: sink },
      { program: createEffectPlanProgram },
    );

    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "start/leaf" },
    });
    const created = events.filter(
      (event) => event.type === "invocation.created",
    );
    const nestedWorkflowIds = created.flatMap((event) =>
      event.type === "invocation.created" && event.subject.type === "workflow"
        ? [event.subject.workflowId]
        : [],
    );
    expect(nestedWorkflowIds).toEqual(
      expect.arrayContaining([middle.id, leaf.id]),
    );
    expect(created).toHaveLength(3);
    const createdIds = created.map((event) => event.invocationId);
    const startedIds = events.flatMap((event) =>
      event.type === "invocation.started" ? [event.invocationId] : [],
    );
    expect(new Set(startedIds)).toEqual(new Set(createdIds));
    expect(terminalInvocations(events)).toHaveLength(created.length);
    expect(events.at(-1)?.type).toBe("run.succeeded");
  });

  it("applies a child default once when its serialized input omits the field", async () => {
    let childInputParses = 0;
    const childInput = z
      .object({ value: z.string().default("default") })
      .transform(({ value }) => {
        childInputParses += 1;
        return { value: `${value}!` };
      });
    const child = createFlow({
      id: "nested-default-child",
      input: childInput,
      output: valueSchema,
    })
      .task(
        "echo",
        task("nested-default-echo", (input) => input),
        ({ input }) => input,
      )
      .output(({ tasks }) => tasks.echo.output)
      .define();
    const authored = buildWorkflow(
      createFlow({
        id: "nested-default-root",
        input: z.object({}),
        output: valueSchema,
      })
        .task("child", child, () => ({ value: "authored" }))
        .output(({ tasks }) => tasks.child.output)
        .define(),
    );
    const plan = planSchema.parse({
      ...authored.plan,
      nodes: authored.plan.nodes.map((node) =>
        node.type === "workflow" ? { ...node, input: {} } : node,
      ),
    });
    const workflow = { ...authored, plan };
    const { sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow, input: {}, events: sink },
      { program: createEffectPlanProgram },
    );

    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
      result: { value: "default!" },
    });
    expect(childInputParses).toBe(1);
  });

  it("preserves a nested output payload with an output field and falsy values", async () => {
    const payloadSchema = z.object({
      output: z.string(),
      enabled: z.boolean(),
      count: z.number(),
      label: z.string(),
    });
    const leafTask = defineTask({
      id: "nested-output-envelope-leaf",
      input: z.object({}),
      output: payloadSchema,
      execute: async () => ({
        output: "domain-value",
        enabled: false,
        count: 0,
        label: "",
      }),
    });
    const child = createFlow({
      id: "nested-output-envelope-child",
      input: z.object({}),
      output: payloadSchema,
    })
      .task("leaf", leafTask, () => ({}))
      .output(({ tasks }) => tasks.leaf.output)
      .define();
    const workflow = buildWorkflow(
      createFlow({
        id: "nested-output-envelope-root",
        input: z.object({}),
        output: payloadSchema,
      })
        .task("child", child, () => ({}))
        .output(({ tasks }) => tasks.child.output)
        .define(),
    );
    const { sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow, input: {}, events: sink },
      { program: createEffectPlanProgram },
    );

    const outcome = await settleBeforeTimeout(handle.outcome);
    await expect(Promise.resolve(outcome)).resolves.toMatchObject({
      status: "succeeded",
      result: { output: "domain-value", enabled: false, count: 0, label: "" },
    });
  });

  it("lets shared sibling workflows overlap on one resource", async () => {
    const bothEntered = deferred();
    const release = deferred();
    let entered = 0;
    const makeChild = (id: string) =>
      taskFlow(
        `${id}-flow`,
        task(`${id}-task`, async (input) => {
          entered += 1;
          if (entered === 2) bothEntered.resolve();
          await release.promise;
          return input;
        }),
        "shared",
      );
    const left = makeChild("nested-shared-left");
    const right = makeChild("nested-shared-right");
    const root = buildWorkflow(
      createFlow({
        id: "nested-shared-root",
        input: valueSchema,
        output: doneSchema,
      })
        .task("left", left, ({ input }) => input, { workspace: "shared" })
        .task("right", right, ({ input }) => input, { workspace: "shared" })
        .output(() => ({ done: "ok" }))
        .define(),
    );
    const { sink } = eventSink();
    const handle = runWithResourceKeys(
      root,
      { value: "shared" },
      sink,
      () => "one-checkout",
    );

    try {
      await settleBeforeTimeout(bothEntered.promise);
      expect(entered).toBe(2);
    } finally {
      release.resolve();
    }
    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("serializes exclusive child writers under shared sibling workflows", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const first = taskFlow(
      "nested-exclusive-first-flow",
      task("nested-exclusive-first-task", async (input) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return input;
      }),
    );
    const second = taskFlow(
      "nested-exclusive-second-flow",
      task("nested-exclusive-second-task", (input) => {
        secondEntered.resolve();
        return input;
      }),
    );
    const root = buildWorkflow(
      createFlow({
        id: "nested-exclusive-root",
        input: valueSchema,
        output: doneSchema,
      })
        .task("first", first, ({ input }) => input, { workspace: "shared" })
        .task("second", second, ({ input }) => input, {
          workspace: "shared",
        })
        .output(() => ({ done: "ok" }))
        .define(),
    );
    const { events, sink, waitFor } = eventSink();
    const handle = runWithResourceKeys(
      root,
      { value: "exclusive" },
      sink,
      () => "one-checkout",
    );

    try {
      await settleBeforeTimeout(firstEntered.promise);
      await settleBeforeTimeout(
        waitFor((current) =>
          current.some(
            (event) =>
              event.type === "invocation.progress" &&
              event.waitingReason === "workspace_unavailable",
          ),
        ),
      );
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            event.taskId === "nested-exclusive-second-task",
        ),
      ).toBe(false);
      releaseFirst.resolve();
      await settleBeforeTimeout(secondEntered.promise);
    } finally {
      releaseFirst.resolve();
    }
    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("keeps nested child bodies progressing under one global bound", async () => {
    const firstEightEntered = deferred();
    const release = deferred();
    let active = 0;
    let maximumActive = 0;
    let entered = 0;
    const children = Array.from({ length: 8 }, (_, index) => {
      const id = `nested-global-${index}`;
      const makeBody = (taskId: string) =>
        task(taskId, async (input) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entered += 1;
          if (entered === 8) firstEightEntered.resolve();
          await release.promise;
          active -= 1;
          return input;
        });
      return createFlow({
        id: `${id}-flow`,
        input: valueSchema,
        output: valueSchema,
      })
        .task("first", makeBody(`${id}-first-task`), ({ input }) => input, {
          workspace: "shared",
        })
        .task("second", makeBody(`${id}-second-task`), ({ input }) => input, {
          workspace: "shared",
        })
        .output(({ tasks }) => tasks.first.output)
        .define();
    });
    const root = buildWorkflow(
      createFlow({
        id: "nested-global-root",
        input: valueSchema,
        output: doneSchema,
      })
        .task("child0", children[0]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child1", children[1]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child2", children[2]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child3", children[3]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child4", children[4]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child5", children[5]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child6", children[6]!, ({ input }) => input, {
          workspace: "shared",
        })
        .task("child7", children[7]!, ({ input }) => input, {
          workspace: "shared",
        })
        .output(() => ({ done: "ok" }))
        .define(),
    );
    const { events, sink, waitFor } = eventSink();
    const handle = runWithResourceKeys(
      root,
      { value: "global-bound" },
      sink,
      (id) => id,
    );
    const expectedTaskIds = Array.from({ length: 8 }, (_, index) => {
      const id = `nested-global-${index}`;
      return [`${id}-first-task`, `${id}-second-task`];
    }).flat();

    try {
      await settleBeforeTimeout(firstEightEntered.promise);
      await settleBeforeTimeout(
        waitFor((current) =>
          expectedTaskIds.every((taskId) =>
            current.some(
              (event) =>
                event.type === "invocation.created" &&
                event.subject.type === "task" &&
                event.subject.taskId === taskId,
            ),
          ),
        ),
      );
      const createdTaskIds = events.flatMap((event) =>
        event.type === "invocation.created" && event.subject.type === "task"
          ? [event.subject.taskId]
          : [],
      );
      expect([...createdTaskIds].sort()).toEqual([...expectedTaskIds].sort());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(entered).toBe(8);
      expect(maximumActive).toBeLessThanOrEqual(8);
    } finally {
      release.resolve();
    }
    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(entered).toBe(16);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it("runs eight selected-choice evaluators only after each body releases workspace admission", async () => {
    const resultSchema = z.object({ value: z.string() });
    const enteredBarrier = deferred();
    const releaseBodies = deferred();
    let activeBodies = 0;
    let maximumActiveBodies = 0;
    let enteredBodies = 0;
    let evaluatorCalls = 0;
    let fallbackCalls = 0;
    const taskDefinitions = Array.from({ length: 8 }, (_, index) =>
      defineTask({
        id: `nested-evaluator-task-${index}`,
        input: z.object({}),
        output: resultSchema,
        execute: async () => {
          enteredBodies += 1;
          activeBodies += 1;
          maximumActiveBodies = Math.max(maximumActiveBodies, activeBodies);
          if (enteredBodies === 8) enteredBarrier.resolve();
          await releaseBodies.promise;
          activeBodies -= 1;
          return { value: `result-${index}` };
        },
      }),
    );
    const evaluatorDefinitions = Array.from({ length: 8 }, (_, index) =>
      defineTask({
        id: `nested-evaluator-${index}`,
        input: resultSchema,
        output: validationResultSchema,
        execute: async (): Promise<z.output<typeof validationResultSchema>> => {
          evaluatorCalls += 1;
          return { success: true as const };
        },
      }),
    );
    const fallbackDefinitions = Array.from({ length: 8 }, (_, index) =>
      defineTask({
        id: `nested-choice-evaluator-fallback-${index}`,
        input: z.object({}),
        output: resultSchema,
        execute: async () => {
          fallbackCalls += 1;
          return { value: "unselected" };
        },
      }),
    );
    const workflow = buildWorkflow(
      createFlow({
        id: "nested-task-evaluator-root",
        input: z.object({
          flag0: z.boolean(),
          flag1: z.boolean(),
          flag2: z.boolean(),
          flag3: z.boolean(),
          flag4: z.boolean(),
          flag5: z.boolean(),
          flag6: z.boolean(),
          flag7: z.boolean(),
        }),
        output: doneSchema,
      })
        .when(({ input }) => input.flag0)
        .task("task0", taskDefinitions[0]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[0]!,
        })
        .otherwise(fallbackDefinitions[0]!, () => ({}))
        .when(({ input }) => input.flag1)
        .task("task1", taskDefinitions[1]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[1]!,
        })
        .otherwise(fallbackDefinitions[1]!, () => ({}))
        .when(({ input }) => input.flag2)
        .task("task2", taskDefinitions[2]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[2]!,
        })
        .otherwise(fallbackDefinitions[2]!, () => ({}))
        .when(({ input }) => input.flag3)
        .task("task3", taskDefinitions[3]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[3]!,
        })
        .otherwise(fallbackDefinitions[3]!, () => ({}))
        .when(({ input }) => input.flag4)
        .task("task4", taskDefinitions[4]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[4]!,
        })
        .otherwise(fallbackDefinitions[4]!, () => ({}))
        .when(({ input }) => input.flag5)
        .task("task5", taskDefinitions[5]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[5]!,
        })
        .otherwise(fallbackDefinitions[5]!, () => ({}))
        .when(({ input }) => input.flag6)
        .task("task6", taskDefinitions[6]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[6]!,
        })
        .otherwise(fallbackDefinitions[6]!, () => ({}))
        .when(({ input }) => input.flag7)
        .task("task7", taskDefinitions[7]!, () => ({}), {
          workspace: "shared",
          validateOutput: evaluatorDefinitions[7]!,
        })
        .otherwise(fallbackDefinitions[7]!, () => ({}))
        .output(() => ({ done: "complete" }))
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = runWithResourceKeys(
      workflow,
      {
        flag0: true,
        flag1: true,
        flag2: true,
        flag3: true,
        flag4: true,
        flag5: true,
        flag6: true,
        flag7: true,
      },
      sink,
      () => "one-checkout",
    );

    try {
      await settleBeforeTimeout(enteredBarrier.promise);
      expect(enteredBodies).toBe(8);
      expect(maximumActiveBodies).toBe(8);
      expect(evaluatorCalls).toBe(0);
    } finally {
      releaseBodies.resolve();
    }
    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(evaluatorCalls).toBe(8);
    expect(fallbackCalls).toBe(0);
    for (let index = 0; index < 8; index += 1) {
      const taskInvocation = events.find(
        (event) =>
          event.type === "invocation.started" &&
          event.subject.type === "task" &&
          event.subject.taskId === `nested-evaluator-task-${index}`,
      );
      expect(taskInvocation?.type).toBe("invocation.started");
      if (taskInvocation?.type !== "invocation.started")
        throw new Error(`Task ${index} did not start`);
      const workspaceReleased = events.findIndex(
        (event) =>
          event.type === "invocation.progress" &&
          event.invocationId === taskInvocation.invocationId &&
          event.phase === "workspace_released",
      );
      const evaluatorStarted = events.findIndex(
        (event) =>
          event.type === "invocation.started" &&
          event.subject.type === "task" &&
          event.subject.taskId === `nested-evaluator-${index}`,
      );
      expect(workspaceReleased).toBeGreaterThanOrEqual(0);
      expect(evaluatorStarted).toBeGreaterThan(workspaceReleased);
    }
  });

  it("shares the repeat-body budget across independent nested loops", async () => {
    const countSchema = z.object({ count: z.number().int() });
    const attemptOutputSchema = countSchema.extend({ done: z.boolean() });
    const executions = new Map<string, number>();
    const makeLoop = (suffix: "left" | "right") => {
      const attemptTask = defineTask({
        id: `nested-budget-${suffix}-attempt`,
        input: countSchema,
        output: attemptOutputSchema,
        execute: async ({ input }) => {
          executions.set(suffix, (executions.get(suffix) ?? 0) + 1);
          return { count: input.count + 1, done: input.count >= 599 };
        },
      });
      return createFlow({
        id: `nested-budget-${suffix}-flow`,
        input: countSchema,
        output: booleanDoneSchema,
      })
        .task("attempt", attemptTask, ({ input }) => input)
        .until(({ result }) => result.done, {
          maxIterations: 600,
          nextInput: ({ result }) => ({ count: result.count }),
        })
        .output(() => ({ done: true }))
        .define();
    };
    const left = makeLoop("left");
    const right = makeLoop("right");
    const workflow = buildWorkflow(
      createFlow({
        id: "nested-budget-root",
        input: z.object({}),
        output: booleanDoneSchema,
      })
        .task("left", left, () => ({ count: 0 }), { workspace: "shared" })
        .task("right", right, () => ({ count: 0 }), { workspace: "shared" })
        .output(() => ({ done: true }))
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = runWithResourceKeys(workflow, {}, sink, (id) => id);

    const outcome = await settleBeforeTimeout(handle.outcome);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    if (!(outcome.error instanceof RunRepeatLimitExceededError))
      throw new Error("Expected the shared repeat execution limit error");
    expect(outcome.error.maximumExecutions).toBe(MAX_REPEAT_BODY_EXECUTIONS);
    expect(outcome.error.attemptedExecution).toBeGreaterThan(
      MAX_REPEAT_BODY_EXECUTIONS,
    );
    expect(executions.get("left")).toBeGreaterThan(0);
    expect(executions.get("right")).toBeGreaterThan(0);
    expect(
      [...executions.values()].reduce((total, count) => total + count, 0),
    ).toBe(MAX_REPEAT_BODY_EXECUTIONS);

    const attempts = events.flatMap((event) =>
      event.type === "invocation.created" &&
      event.iteration !== undefined &&
      event.subject.type === "task" &&
      (event.subject.taskId === "nested-budget-left-attempt" ||
        event.subject.taskId === "nested-budget-right-attempt")
        ? [{ invocationId: event.invocationId, taskId: event.subject.taskId }]
        : [],
    );
    expect(attempts).toHaveLength(MAX_REPEAT_BODY_EXECUTIONS);
    expect(new Set(attempts.map((event) => event.invocationId)).size).toBe(
      MAX_REPEAT_BODY_EXECUTIONS,
    );
    expect(new Set(attempts.map((event) => event.taskId))).toEqual(
      new Set(["nested-budget-left-attempt", "nested-budget-right-attempt"]),
    );
  });

  it("settles held nested cleanup before publishing the root cancellation", async () => {
    const childEntered = deferred();
    const releaseChild = deferred();
    const child = taskFlow(
      "nested-cancel-child-flow",
      task("nested-cancel-child-task", async (input) => {
        childEntered.resolve();
        await releaseChild.promise;
        return input;
      }),
    );
    const root = buildWorkflow(
      createFlow({
        id: "nested-cancel-root",
        input: valueSchema,
        output: valueSchema,
      })
        .task("child", child, ({ input }) => input)
        .output(({ tasks }) => tasks.child.output)
        .define(),
    );
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow: root, input: { value: "cancel" }, events: sink },
      { program: createEffectPlanProgram },
    );

    try {
      await settleBeforeTimeout(childEntered.promise);
      const cancellation = handle.cancel();
      await Promise.resolve();
      expect(events.some((event) => event.type === "run.cancelled")).toBe(
        false,
      );
      releaseChild.resolve();
      await settleBeforeTimeout(cancellation);
    } finally {
      releaseChild.resolve();
    }
    await expect(settleBeforeTimeout(handle.outcome)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(events.at(-1)?.type).toBe("run.cancelled");
    const childInvocation = events.find(
      (event) =>
        event.type === "invocation.started" &&
        event.subject?.type === "workflow",
    );
    expect(childInvocation).toBeDefined();
    if (childInvocation?.type !== "invocation.started")
      throw new Error("Expected child invocation start");
    const childTerminal = terminalInvocations(events).find(
      (event) => event.invocationId === childInvocation.invocationId,
    );
    expect(childTerminal).toBeDefined();
    expect(events.indexOf(childTerminal!)).toBeLessThan(events.length - 1);
  });
});
