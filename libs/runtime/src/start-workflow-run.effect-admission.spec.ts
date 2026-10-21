// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/execution/effect-plan.ts
// @test-scope ./runtime/execution/program.ts
// @test-scope ./runtime/execution/run-sequential-graph.ts
// @test-scope ./runtime/invocation/invocation-execution.ts
// @test-scope ./runtime/invocation/joint-admission.ts
// @test-scope ./runtime/invocation/task-admission.ts
// @test-scope ./runtime/compile/compile-node-step.ts
// @test-scope ./runtime/session/session-lock.ts
// @test-scope ./runtime/workspace/workspace-lock.ts
// @test-scope ./runner/profile/runtime-profile.ts
// @test-scope ../../fixtures/src/model-selection-workflow.ts
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentRuntime,
} from "@seqlane/agent-adapter";
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineTask,
  type SeqlaneEvent,
  type TaskDefinition,
} from "@seqlane/core";
import { modelSelectionWorkflow } from "@seqlane/fixtures/model-selection-workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";
import { createEffectPlanProgram } from "./runtime/execution/effect-plan.js";
import { findUnconfirmedInvocationTermination } from "./runtime/execution/executor.js";

const recordSchema = z.object({ value: z.string() });
const fullCapabilities: AgentAdapterCapabilities = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: true,
  sessionUi: false,
};

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

interface CallerTask {
  readonly task: TaskDefinition;
  readonly workspace: "shared" | "exclusive";
}

function flowBuilder(id: string) {
  return createFlow({
    id,
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
  });
}

function bindTask(task: CallerTask) {
  return () => ({ value: task.task.id });
}

function buildTwoTaskFlow(id: string, first: CallerTask, second: CallerTask) {
  return buildWorkflow(
    flowBuilder(id)
      .task("first", first.task, bindTask(first), {
        dependsOn: [],
        workspace: first.workspace,
      })
      .task("second", second.task, bindTask(second), {
        dependsOn: [],
        workspace: second.workspace,
      })
      .output(() => ({ done: true }))
      .define(),
  );
}

function buildThreeTaskFlow(
  id: string,
  first: CallerTask,
  second: CallerTask,
  third: CallerTask,
) {
  return buildWorkflow(
    flowBuilder(id)
      .task("first", first.task, bindTask(first), {
        dependsOn: [],
        workspace: first.workspace,
      })
      .task("second", second.task, bindTask(second), {
        dependsOn: [],
        workspace: second.workspace,
      })
      .task("third", third.task, bindTask(third), {
        dependsOn: [],
        workspace: third.workspace,
      })
      .output(() => ({ done: true }))
      .define(),
  );
}

function buildTenTaskFlow(
  owner: CallerTask,
  waiters: readonly [
    CallerTask,
    CallerTask,
    CallerTask,
    CallerTask,
    CallerTask,
    CallerTask,
    CallerTask,
    CallerTask,
  ],
  compatible: CallerTask,
) {
  return buildWorkflow(
    flowBuilder("direct-effect-permit-starvation")
      .task("owner", owner.task, bindTask(owner), {
        dependsOn: [],
        workspace: owner.workspace,
      })
      .task("waiter-0", waiters[0].task, bindTask(waiters[0]), {
        dependsOn: [],
        workspace: waiters[0].workspace,
      })
      .task("waiter-1", waiters[1].task, bindTask(waiters[1]), {
        dependsOn: [],
        workspace: waiters[1].workspace,
      })
      .task("waiter-2", waiters[2].task, bindTask(waiters[2]), {
        dependsOn: [],
        workspace: waiters[2].workspace,
      })
      .task("waiter-3", waiters[3].task, bindTask(waiters[3]), {
        dependsOn: [],
        workspace: waiters[3].workspace,
      })
      .task("waiter-4", waiters[4].task, bindTask(waiters[4]), {
        dependsOn: [],
        workspace: waiters[4].workspace,
      })
      .task("waiter-5", waiters[5].task, bindTask(waiters[5]), {
        dependsOn: [],
        workspace: waiters[5].workspace,
      })
      .task("waiter-6", waiters[6].task, bindTask(waiters[6]), {
        dependsOn: [],
        workspace: waiters[6].workspace,
      })
      .task("waiter-7", waiters[7].task, bindTask(waiters[7]), {
        dependsOn: [],
        workspace: waiters[7].workspace,
      })
      .task("compatible", compatible.task, bindTask(compatible), {
        dependsOn: [],
        workspace: compatible.workspace,
      })
      .output(() => ({ done: true }))
      .define(),
  );
}

function makeTask(
  id: string,
  execute: TaskDefinition["execute"],
  workspace: "shared" | "exclusive" = "shared",
): CallerTask {
  return {
    task: defineTask({
      id,
      input: recordSchema,
      output: recordSchema,
      execute,
    }),
    workspace,
  };
}

function runtimeFor(options: {
  readonly capabilities?: AgentAdapterCapabilities;
  readonly adapter: (ordinal: number) => AgentAdapter;
  readonly onClose?: () => Promise<void>;
  readonly onCreate?: () => void;
}): AgentRuntime {
  let ordinal = 0;
  const capabilities = options.capabilities ?? fullCapabilities;
  return {
    identity: "effect-direct-caller-fixture",
    capabilities,
    modelCapabilities: {
      executor: "fixture-agent",
      listModels: async () => [
        { provider: "openai", model: "gpt-6.1-sol" },
        { provider: "openai", model: "gpt-6-luna" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      ],
      resolveDefaultModel: async () => ({
        model: { provider: "openai", model: "gpt-6.1-sol" },
        reasoning: "medium",
      }),
    },
    createAdapter: () => {
      options.onCreate?.();
      const adapter = options.adapter(++ordinal);
      return {
        ...adapter,
        ...(capabilities.checkpoint && adapter.captureCheckpoint === undefined
          ? { captureCheckpoint: async () => ({ checkpoint: "fixture" }) }
          : {}),
        ...(capabilities.fork && adapter.fork === undefined
          ? {
              fork: async () => {
                throw new Error("Unexpected fixture checkpoint fork");
              },
            }
          : {}),
      };
    },
    redactAdapter: (adapter) => adapter,
    close: options.onClose,
  };
}

async function settleBeforeTimeout<A>(promise: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Caller fixture did not reach its barrier")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasCause(value: unknown, expected: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<Error>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === expected) return true;
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

describe("startWorkflowRun Effect session and workspace admission", () => {
  it("keeps a native adapter rejection behind task cancellation in the target run", async () => {
    const task = defineAgentTask({
      id: "late-native-adapter-rejection",
      input: recordSchema,
      output: recordSchema,
      timeoutMs: 1,
      goal: () => "Wait for cancellation.",
    });
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-late-native-adapter-rejection",
        input: z.object({}),
        output: recordSchema,
      })
        .task("task", task, () => ({ value: "input" }))
        .output(({ tasks }) => tasks.task.output)
        .define(),
    );
    const sdkFailure = new Error("late native SDK failure");
    let closeBeforeTerminal = false;
    const { events, sink } = eventSink();
    const agentRuntime = runtimeFor({
      onClose: async () => {
        closeBeforeTerminal = !events.some((event) =>
          ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type),
        );
      },
      adapter: () => ({
        capabilities: fullCapabilities,
        execute: async (request) => {
          request.onExecutionStarted();
          return new Promise((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(sdkFailure), {
              once: true,
            }),
          );
        },
      }),
    });
    const handle = startWorkflowRun(
      { workflow: built, input: {}, agentRuntime, events: sink },
      { program: createEffectPlanProgram },
    );

    const outcome = await settleBeforeTimeout(handle.outcome);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(hasCause(outcome.error, sdkFailure)).toBe(true);
    }
    expect(closeBeforeTerminal).toBe(true);
    expect(
      events.filter((event) =>
        ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type),
      ),
    ).toHaveLength(1);
  });

  it("runs authored reuse and fork sessions with a stable checkpoint and closes before the terminal event", async () => {
    const built = buildWorkflow(modelSelectionWorkflow);
    const { events, sink } = eventSink();
    const adapterIds = new Map<string, number>();
    const selections = new Map<string, unknown[]>();
    let sourceActivityFinished = false;
    let checkpoint: unknown;
    let closeCount = 0;
    let closedBeforeTerminal = false;
    const agentRuntime = runtimeFor({
      adapter: (ordinal) => {
        const id = ordinal;
        return {
          capabilities: fullCapabilities,
          execute: async (request) => {
            request.onExecutionStarted();
            const name = request.task.id;
            adapterIds.set(name, id);
            const seen = selections.get(name) ?? [];
            seen.push(request.modelSelection);
            selections.set(name, seen);
            if (name === "model-selection.source")
              sourceActivityFinished = true;
            return request.input;
          },
          captureCheckpoint: async () => {
            expect(sourceActivityFinished).toBe(true);
            checkpoint = { after: "source-activity" };
            return checkpoint;
          },
          fork: async ({ checkpoint: forkCheckpoint }) => {
            expect(forkCheckpoint).toBe(checkpoint);
            return {
              capabilities: fullCapabilities,
              execute: async (request) => {
                request.onExecutionStarted();
                const name = request.task.id;
                adapterIds.set(name, id + 100);
                const seen = selections.get(name) ?? [];
                seen.push(request.modelSelection);
                selections.set(name, seen);
                return request.input;
              },
              captureCheckpoint: async () => checkpoint,
              fork: async () => {
                throw new Error("Unexpected nested checkpoint fork");
              },
            };
          },
        };
      },
      onClose: async () => {
        closeCount += 1;
        closedBeforeTerminal = !events.some((event) =>
          ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type),
        );
      },
    });
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: { label: "direct" },
        agentRuntime,
        events: sink,
      },
      { program: createEffectPlanProgram },
    );

    const outcome = await handle.outcome;
    if (outcome.status === "failed") throw outcome.error;
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(adapterIds.get("model-selection.reuse")).toBe(
      adapterIds.get("model-selection.source"),
    );
    expect(adapterIds.get("model-selection.fork")).not.toBe(
      adapterIds.get("model-selection.source"),
    );
    expect(selections.get("model-selection.reuse")?.[0]).toEqual(
      selections.get("model-selection.source")?.[0],
    );
    expect(selections.get("model-selection.fork")?.[0]).toEqual({
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "low",
    });
    expect(checkpoint).toEqual({ after: "source-activity" });
    expect(closeCount).toBe(1);
    expect(closedBeforeTerminal).toBe(true);
  });

  it("rejects missing session reuse capability before creating an adapter", async () => {
    let creates = 0;
    let executes = 0;
    const agentRuntime = runtimeFor({
      capabilities: { ...fullCapabilities, sessionReuse: false },
      onCreate: () => {
        creates += 1;
      },
      adapter: () => ({
        capabilities: { ...fullCapabilities, sessionReuse: false },
        execute: async (request) => {
          executes += 1;
          request.onExecutionStarted();
          return request.input;
        },
      }),
    });
    const handle = startWorkflowRun(
      {
        workflow: buildWorkflow(modelSelectionWorkflow),
        input: { label: "missing-capability" },
        agentRuntime,
        events: { emit: () => undefined },
      },
      { program: createEffectPlanProgram },
    );

    await expect(handle.outcome).resolves.toMatchObject({ status: "failed" });
    expect(creates).toBe(0);
    expect(executes).toBe(0);
  });

  it("closes late resolver acquisition after cancellation without preflight or task work", async () => {
    const resolverStarted = deferred();
    const releaseResolver = deferred();
    let creates = 0;
    let executions = 0;
    let modelLookups = 0;
    let closeCount = 0;
    const agentRuntime = runtimeFor({
      onCreate: () => {
        creates += 1;
      },
      onClose: async () => {
        closeCount += 1;
      },
      adapter: () => ({
        capabilities: fullCapabilities,
        execute: async (request) => {
          executions += 1;
          request.onExecutionStarted();
          return request.input;
        },
      }),
    });
    const modelCapabilities = agentRuntime.modelCapabilities;
    if (modelCapabilities === undefined)
      throw new Error("Fixture runtime has no model capabilities");
    const workflow = buildWorkflow(modelSelectionWorkflow);
    const handle = startWorkflowRun(
      {
        workflow,
        input: { label: "late-acquisition" },
        agentRuntime: {
          ...agentRuntime,
          modelCapabilities: {
            ...modelCapabilities,
            listModels: async () => {
              modelLookups += 1;
              return modelCapabilities.listModels();
            },
          },
        },
        events: { emit: () => undefined },
      },
      {
        program: (context) =>
          createEffectPlanProgram({
            ...context,
            resolveExecution: async (signal) => {
              resolverStarted.resolve();
              await releaseResolver.promise;
              return context.resolveExecution(signal);
            },
          }),
      },
    );

    await settleBeforeTimeout(resolverStarted.promise);
    const cancellation = handle.cancel();
    releaseResolver.resolve();
    await cancellation;
    await expect(handle.outcome).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(creates).toBe(0);
    expect(executions).toBe(0);
    expect(modelLookups).toBe(0);
    expect(closeCount).toBe(1);
  });

  it("overlaps compatible shared work and delays an exclusive conflict", async () => {
    const bothSharedStarted = deferred();
    const releaseShared = deferred();
    const exclusiveStarted = deferred();
    let sharedCount = 0;
    const sharedA = makeTask("a-shared", async ({ input }) => {
      sharedCount += 1;
      if (sharedCount === 2) bothSharedStarted.resolve();
      await releaseShared.promise;
      return input;
    });
    const sharedB = makeTask("b-shared", async ({ input }) => {
      sharedCount += 1;
      if (sharedCount === 2) bothSharedStarted.resolve();
      await releaseShared.promise;
      return input;
    });
    const exclusiveC = makeTask(
      "z-exclusive",
      async ({ input }) => {
        exclusiveStarted.resolve();
        return input;
      },
      "exclusive",
    );
    const built = buildThreeTaskFlow(
      "direct-effect-shared-exclusive",
      sharedA,
      sharedB,
      exclusiveC,
    );
    expect(
      built.plan.nodes.flatMap((node) =>
        node.type === "task" ? [node.workspace] : [],
      ),
    ).toEqual(["shared", "shared", "exclusive"]);
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      {
        workflow: built,
        input: {},
        events: sink,
      },
      { program: createEffectPlanProgram },
    );

    try {
      await settleBeforeTimeout(bothSharedStarted.promise);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sharedCount).toBe(2);
      let exclusiveDidStart = false;
      void exclusiveStarted.promise.then(() => {
        exclusiveDidStart = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        exclusiveDidStart,
        JSON.stringify(
          events.filter((event) => event.type.startsWith("invocation.")),
        ),
      ).toBe(false);
    } finally {
      releaseShared.resolve();
    }
    await settleBeforeTimeout(exclusiveStarted.promise);
    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("cancels exclusive admission waiters before they enter task callbacks", async () => {
    const ownerStarted = deferred();
    const releaseOwner = deferred();
    let waiterStarted = false;
    const owner = makeTask(
      "a-exclusive-owner",
      async ({ input }) => {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return input;
      },
      "exclusive",
    );
    const waiter = makeTask(
      "b-exclusive-waiter",
      async ({ input }) => {
        waiterStarted = true;
        return input;
      },
      "exclusive",
    );
    const { sink, waitFor } = eventSink();
    const handle = startWorkflowRun(
      {
        workflow: buildTwoTaskFlow(
          "direct-effect-admission-cancel",
          owner,
          waiter,
        ),
        input: {},
        events: sink,
      },
      { program: createEffectPlanProgram },
    );
    try {
      await settleBeforeTimeout(ownerStarted.promise);
      await settleBeforeTimeout(
        waitFor((events) =>
          events.some(
            (event) =>
              event.type === "invocation.progress" &&
              event.waitingReason === "workspace_unavailable",
          ),
        ),
      );
      const cancellation = handle.cancel();
      releaseOwner.resolve();
      await cancellation;
    } finally {
      releaseOwner.resolve();
    }
    await expect(handle.outcome).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(waiterStarted).toBe(false);
  });

  it("keeps eight blocked waiters from consuming permits needed by compatible work", async () => {
    const ownerStarted = deferred();
    const releaseOwner = deferred();
    const compatibleStarted = deferred();
    const owner = makeTask(
      "a-permit-owner",
      async ({ input }) => {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return input;
      },
      "exclusive",
    );
    const waiters = [
      makeTask("b-permit-waiter-0", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-1", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-2", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-3", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-4", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-5", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-6", async ({ input }) => input, "exclusive"),
      makeTask("b-permit-waiter-7", async ({ input }) => input, "exclusive"),
    ] as const;
    const compatible = makeTask(
      "z-permit-compatible",
      async ({ input }) => {
        compatibleStarted.resolve();
        return input;
      },
      "shared",
    );
    const built = buildTenTaskFlow(owner, waiters, compatible);
    const { events, sink, waitFor } = eventSink();
    const handle = startWorkflowRun(
      { workflow: built, input: {}, events: sink },
      {
        program: (context) =>
          createEffectPlanProgram({
            ...context,
            resolveExecution: async (signal) => {
              const execution = await context.resolveExecution(signal);
              const workspaceResources = new Map(execution.workspaceResources);
              workspaceResources.set("a-permit-owner", { key: "blocked" });
              for (let index = 0; index < 8; index += 1) {
                workspaceResources.set(`b-permit-waiter-${index}`, {
                  key: "blocked",
                });
              }
              workspaceResources.set("z-permit-compatible", { key: "free" });
              return { ...execution, workspaceResources };
            },
          }),
      },
    );

    try {
      await settleBeforeTimeout(ownerStarted.promise);
      await settleBeforeTimeout(
        waitFor(
          (current) =>
            current.filter(
              (event) =>
                event.type === "invocation.progress" &&
                event.waitingReason === "workspace_unavailable",
            ).length >= 8,
        ),
      );
      await settleBeforeTimeout(compatibleStarted.promise);
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            "taskId" in event &&
            event.taskId === "z-permit-compatible",
        ),
      ).toBe(true);
    } finally {
      releaseOwner.resolve();
    }
    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("retains uncertain workspace ownership while unrelated work settles", async () => {
    const uncertainStarted = deferred();
    const abortObserved = deferred();
    const uncertainReported = deferred();
    const releaseUncertain = deferred();
    const unrelatedStarted = deferred();
    let conflictingStarted = false;
    const uncertainTask = defineAgentTask({
      id: "a-uncertain-owner",
      input: recordSchema,
      output: recordSchema,
      goal: () => "Report a disconnected operation.",
    });
    const conflictingTask = defineAgentTask({
      id: "b-uncertain-conflict",
      input: recordSchema,
      output: recordSchema,
      goal: () => "Try the quarantined workspace.",
    });
    const unrelatedEntry = makeTask("c-unrelated-work", async ({ input }) => {
      unrelatedStarted.resolve();
      return input;
    });
    const unrelatedTask = unrelatedEntry.task;
    const built = buildWorkflow(
      createFlow({
        id: "direct-effect-uncertain-ownership",
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
      })
        .task("a-owner", uncertainTask, () => ({ value: "owner" }), {
          dependsOn: [],
          workspace: "exclusive",
        })
        .task("b-conflict", conflictingTask, () => ({ value: "conflict" }), {
          dependsOn: [],
          workspace: "exclusive",
        })
        .task("c-unrelated", unrelatedTask, () => ({ value: "unrelated" }), {
          dependsOn: [],
        })
        .output(() => ({ done: true }))
        .define(),
    );
    const agentRuntime = runtimeFor({
      adapter: () => ({
        capabilities: fullCapabilities,
        execute: async (request) => {
          request.onExecutionStarted();
          if (request.task.id === uncertainTask.id) {
            uncertainStarted.resolve();
            request.signal.addEventListener(
              "abort",
              () => abortObserved.resolve(),
              {
                once: true,
              },
            );
            await abortObserved.promise;
            request.onUncertainActivity?.({ reason: "disconnect" });
            uncertainReported.resolve();
            await releaseUncertain.promise;
          } else {
            conflictingStarted = true;
          }
          return request.input;
        },
      }),
    });
    const { events, sink } = eventSink();
    const handle = startWorkflowRun(
      { workflow: built, input: {}, agentRuntime, events: sink },
      {
        program: (context) =>
          createEffectPlanProgram({
            ...context,
            resolveExecution: async (signal) => {
              const execution = await context.resolveExecution(signal);
              const workspaceResources = new Map(execution.workspaceResources);
              workspaceResources.set(uncertainTask.id, { key: "quarantined" });
              workspaceResources.set(conflictingTask.id, {
                key: "quarantined",
              });
              workspaceResources.set(unrelatedTask.id, { key: "unrelated" });
              return { ...execution, workspaceResources };
            },
          }),
      },
    );

    try {
      await settleBeforeTimeout(uncertainStarted.promise);
      await settleBeforeTimeout(unrelatedStarted.promise);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(conflictingStarted).toBe(false);
      const cancellation = handle.cancel();
      await settleBeforeTimeout(uncertainReported.promise);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(conflictingStarted).toBe(false);
      releaseUncertain.resolve();
      await cancellation;
    } finally {
      releaseUncertain.resolve();
    }
    const outcome = await settleBeforeTimeout(handle.outcome);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(findUnconfirmedInvocationTermination(outcome.error)).toBeDefined();
    }
    const ownerStarted = events.find(
      (event) =>
        event.type === "invocation.started" &&
        event.taskId === uncertainTask.id,
    );
    const ownerInvocationId =
      ownerStarted?.type === "invocation.started"
        ? ownerStarted.invocationId
        : undefined;
    expect(ownerInvocationId).toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "invocation.failed" &&
          event.invocationId === ownerInvocationId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "invocation.cancelled" &&
          event.invocationId === ownerInvocationId,
      ),
    ).toBe(false);
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it.each([
    ["success", false],
    ["failed", true],
    ["cancelled", false],
  ] as const)(
    "settles %s after a run-scoped close failure",
    async (mode, taskFails) => {
      let terminalAtClose: boolean | undefined;
      let closeCount = 0;
      const taskStarted = deferred();
      const releaseTask = deferred();
      const closeFailure = new Error("fixture close failed");
      const task = defineAgentTask({
        id: `close-${mode}`,
        input: recordSchema,
        output: recordSchema,
        goal: () => "Finish the cleanup fixture.",
      });
      const built = buildWorkflow(
        createFlow({
          id: `direct-effect-close-${mode}`,
          input: z.object({}),
          output: z.object({ value: z.string() }),
        })
          .task("task", task, () => ({ value: "done" }))
          .output(({ tasks }) => tasks.task.output)
          .define(),
      );
      const agentRuntime = runtimeFor({
        onClose: async () => {
          closeCount += 1;
          terminalAtClose = events.some(
            (event) =>
              event.type === "run.succeeded" ||
              event.type === "run.failed" ||
              event.type === "run.cancelled",
          );
          throw closeFailure;
        },
        adapter: () => ({
          capabilities: fullCapabilities,
          execute: async (request) => {
            request.onExecutionStarted();
            if (mode === "cancelled") {
              taskStarted.resolve();
              await releaseTask.promise;
            }
            if (taskFails) throw new Error("primary task failure");
            return request.input;
          },
        }),
      });
      const { events, sink } = eventSink();
      const diagnostics: string[] = [];
      const handle = startWorkflowRun(
        {
          workflow: built,
          input: {},
          agentRuntime,
          events: sink,
          onDiagnostic: (message) => diagnostics.push(message),
        },
        { program: createEffectPlanProgram },
      );

      let outcome;
      if (mode === "cancelled") {
        await settleBeforeTimeout(taskStarted.promise);
        const cancellation = handle.cancel();
        releaseTask.resolve();
        await cancellation;
        outcome = await settleBeforeTimeout(handle.outcome);
      } else {
        outcome = await settleBeforeTimeout(handle.outcome);
      }
      expect(terminalAtClose).toBe(false);
      expect(closeCount).toBe(1);
      expect(events.at(-1)?.type).toBe(
        mode === "cancelled" ? "run.cancelled" : "run.failed",
      );
      if (mode === "success") {
        expect(outcome.status).toBe("failed");
        if (outcome.status === "failed")
          expect(outcome.error).toMatchObject({ cause: closeFailure });
      } else if (mode === "failed") {
        expect(outcome.status).toBe("failed");
        expect(diagnostics).toHaveLength(1);
        if (outcome.status === "failed")
          expect(outcome.error.message).toContain("primary task failure");
      } else {
        expect(outcome.status).toBe("cancelled");
        expect(diagnostics).toHaveLength(1);
      }
    },
  );
});
