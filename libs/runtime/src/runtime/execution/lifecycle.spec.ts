// @test-scope ./workflow-run.ts
// @test-scope ./effect-plan.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../compile/compile-node-step.ts
// @test-scope ../invocation/invocation-execution.ts
import type {
  Plan,
  PlanNode,
  SeqlaneSchema,
  TaskDefinition,
  ValueBinding,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  ExecutorError,
  InteractionRequiredError,
  InputValidationError,
  OutputValidationError,
  RuntimeError,
  type SeqlaneEvent,
  type SeqlaneRunOutcome,
} from "../../index.js";
import {
  startCompiledWorkflow,
  runCompiledWorkflow,
} from "./workflow-run.test-support.js";
import { createSequentialProgram } from "./program.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutorRequest } from "./executor.js";
import type { SessionResolver } from "../session/session-resolution.js";
import type { TaskSchema } from "../plan/task-schema.js";
import { z } from "zod";

const throwingSchema = (message: string): SeqlaneSchema =>
  z.custom<unknown>(() => {
    throw new Error(message);
  });

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  input: ValueBinding = {},
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input,
    dependsOn,
  } as PlanNode;
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

function compile(
  source: Plan,
  options: {
    events?: { emit(event: SeqlaneEvent): void };
    executor?: (request: ExecutorRequest) => Promise<unknown>;
    taskSchemas?: ReadonlyMap<string, TaskSchema>;
    taskDefinitions?: ReadonlyMap<string, TaskDefinition>;
    sessionResolver?: SessionResolver;
  } = {},
) {
  const taskDefinitions = new Map(options.taskDefinitions);
  for (const node of source.nodes) {
    if (node.type !== "task" || taskDefinitions.has(node.taskId)) continue;
    const schema = z.unknown();
    taskDefinitions.set(node.taskId, {
      id: node.taskId,
      input: schema,
      output: schema,
      execute: async ({ context }) => context.runAgent({ goal: node.taskId }),
    });
  }
  return new PlanCompiler().compileWorkflow(source, {
    workId: "test-work",
    runId: "run-1",
    workflowInput: { value: "input" },
    createInvocationId: (nodeId) => nodeId,
    events: options.events,
    taskSchemas: options.taskSchemas,
    taskDefinitions,
    sessionResolver: options.sessionResolver,
    executors: new Map([
      [
        "test-executor",
        { execute: options.executor ?? (async () => ({ value: "output" })) },
      ],
    ]),
  });
}

function expectOneTerminalPerCreatedInvocation(
  events: readonly SeqlaneEvent[],
): void {
  const created = events.filter((event) => event.type === "invocation.created");
  const terminal = events.filter(
    (event) =>
      event.type === "invocation.succeeded" ||
      event.type === "invocation.failed" ||
      event.type === "invocation.cancelled" ||
      event.type === "invocation.skipped",
  );

  expect(terminal).toHaveLength(created.length);
  expect(terminal.map((event) => event.invocationId).sort()).toEqual(
    created.map((event) => event.invocationId).sort(),
  );
}

describe("Seqlane lifecycle events and outcomes", () => {
  it("cancels a workflow when its external signal aborts", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let executorAborted = false;
    const compiled = compile(plan([task("slow")]), {
      executor: async ({ signal }) => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            executorAborted = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              executorAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { value: "cancelled" };
      },
    });
    const active = startCompiledWorkflow(compiled, {
      signal: controller.signal,
    });

    await started;
    controller.abort();

    await expect(active.outcome).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(executorAborted).toBe(true);
  });

  it("releases a DAG result after its final distinct task consumer", async () => {
    const availability: boolean[] = [];
    const compiled = compile(
      plan(
        [
          task("final", ["first", "second"], {
            first: { type: "ref", nodeId: "first", path: ["value"] },
            second: { type: "ref", nodeId: "second", path: ["value"] },
          }),
          task("second", ["source"], {
            value: { type: "ref", nodeId: "source", path: ["value"] },
          }),
          task("first", ["source"], {
            value: { type: "ref", nodeId: "source", path: ["value"] },
          }),
          task("source"),
        ],
        {
          type: "ref",
          nodeId: "final",
          path: ["value"],
        },
      ),
      {
        executor: async ({ taskId }) => {
          if (taskId === "first" || taskId === "second") {
            availability.push(compiled.context.results.has("source"));
          }
          return { value: taskId };
        },
      },
    );

    await runCompiledWorkflow(compiled);

    expect(availability).toEqual([true, false]);
    expect(compiled.context.results.has("source")).toBe(false);
  });

  it("retains a final-output source after its last task consumer", async () => {
    let availableAfterTaskInput = false;
    const compiled = compile(
      plan(
        [
          task("consumer", ["source"], {
            value: { type: "ref", nodeId: "source", path: ["value"] },
          }),
          task("source"),
        ],
        { type: "ref", nodeId: "source", path: ["value"] },
      ),
      {
        executor: async ({ taskId }) => {
          if (taskId === "consumer") {
            availableAfterTaskInput = compiled.context.results.has("source");
          }
          return { value: taskId };
        },
      },
    );

    await runCompiledWorkflow(compiled);

    expect(availableAfterTaskInput).toBe(true);
    expect(compiled.context.results.has("source")).toBe(false);
  });

  it("counts repeated references in one task input once", async () => {
    let availableAfterInput = true;
    const compiled = compile(
      plan(
        [
          task("consumer", ["source"], {
            first: { type: "ref", nodeId: "source", path: ["value"] },
            second: { type: "ref", nodeId: "source", path: ["value"] },
          }),
          task("source"),
        ],
        { type: "ref", nodeId: "consumer", path: ["value"] },
      ),
      {
        executor: async ({ taskId }) => {
          if (taskId === "consumer") {
            availableAfterInput = compiled.context.results.has("source");
          }
          return { value: taskId };
        },
      },
    );

    await runCompiledWorkflow(compiled);

    expect(availableAfterInput).toBe(false);
  });

  it("preserves task summaries before releasing the final result", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
    });

    await runCompiledWorkflow(compiled);

    expect(compiled.context.results.has("a")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        summary: { kind: "object", size: 1, fields: ["value"] },
      }),
    );
  });

  it("emits run and invocation events in order with Seqlane identities", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(
      plan([task("a")], {
        type: "ref",
        nodeId: "a",
        path: ["value"],
      }),
      { events: { emit: (event) => events.push(event) } },
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome).toEqual({ status: "succeeded", result: "output" });
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "invocation.created",
      "invocation.progress",
      "invocation.started",
      "invocation.progress",
      "invocation.output",
      "invocation.input",
      "invocation.result",
      "invocation.succeeded",
      "invocation.output",
      "invocation.progress",
      "run.succeeded",
    ]);
    expect(events[1]).toMatchObject({
      type: "invocation.created",
      invocationId: "a",
      planNodeId: "a",
      kind: "task",
      label: "a",
      siblingOrder: 0,
      dependencyIds: [],
    });
    expect(events[7]).toMatchObject({
      type: "invocation.result",
      result: { state: "present", value: { value: "output" } },
    });
    expect(events[6]).toMatchObject({
      type: "invocation.input",
      input: { state: "present", value: {} },
    });
    expect(events[9]).toMatchObject({
      type: "invocation.output",
      policy: "persistent",
      content: "Task completed",
      summary: { kind: "object", size: 1, fields: ["value"] },
    });
  });

  it("propagates executor metrics and a bounded output shape", async () => {
    const events: SeqlaneEvent[] = [];
    const metrics = {
      durationMs: 1250,
      model: "fake-model",
      provider: "fake-provider",
      cost: 0.0042,
      tokens: {
        total: 42,
        input: 20,
        output: 12,
        reasoning: 8,
        cacheRead: 2,
        cacheWrite: 0,
      },
    } as const;
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      executor: async ({ onMetrics }) => {
        onMetrics?.(metrics);
        return {
          files: ["package.json"],
          summary: "safe shape only",
          secret: "must not be emitted",
        };
      },
    });
    const modelSelection = {
      model: { provider: "openai", model: "gpt-5.2" },
      reasoning: "high" as const,
    };
    compiled.context.effectiveModelSelections.set("a", modelSelection);

    await runCompiledWorkflow(compiled);

    const output = events.find(
      (event) =>
        event.type === "invocation.output" && event.policy === "persistent",
    );
    expect(output).toMatchObject({
      metrics: { ...metrics, modelSelection },
      summary: {
        kind: "object",
        size: 3,
        fields: ["files", "summary", "secret"],
      },
    });
    expect(output).not.toHaveProperty("summary.values");
  });

  it("emits effective selection metrics when the executor reports no metrics", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      executor: async () => ({ value: "output" }),
    });
    const modelSelection = {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "medium" as const,
    };
    compiled.context.effectiveModelSelections.set("a", modelSelection);

    await runCompiledWorkflow(compiled);

    expect(
      events.find(
        (event) =>
          event.type === "invocation.output" && event.policy === "persistent",
      ),
    ).toMatchObject({ metrics: { modelSelection } });
  });

  it("emits full executor activity in invocation order", async () => {
    const events: SeqlaneEvent[] = [];
    const taskDefinition: TaskDefinition = {
      id: "a",
      input: z.unknown(),
      output: z.unknown(),
      execute: async ({ context }) => context.runAgent({ goal: "test" }),
    };
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      taskDefinitions: new Map([["a", taskDefinition]]),
      taskSchemas: new Map([["a", taskDefinition]]),
      executor: async ({ onActivity }) => {
        onActivity?.({
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "started",
          input: { path: "/repo/package.json", secret: "hidden" },
        });
        onActivity?.({
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          output: { bytes: 12, content: "hidden" },
        });
        return { value: "output" };
      },
    });

    await runCompiledWorkflow(compiled);

    expect(
      events.filter((event) => event.type === "invocation.activity"),
    ).toEqual([
      expect.objectContaining({
        state: "started",
        input: {
          state: "present",
          value: { path: "/repo/package.json", secret: "hidden" },
        },
      }),
      expect.objectContaining({
        state: "succeeded",
        output: { state: "present", value: { bytes: 12, content: "hidden" } },
      }),
    ]);
  });

  it("includes full executor activity by default", async () => {
    const events: SeqlaneEvent[] = [];
    const taskDefinition: TaskDefinition = {
      id: "a",
      input: z.unknown(),
      output: z.unknown(),
      execute: async ({ context }) => context.runAgent({ goal: "test" }),
    };
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      taskDefinitions: new Map([["a", taskDefinition]]),
      taskSchemas: new Map([["a", taskDefinition]]),
      executor: async ({ onActivity }) => {
        onActivity?.({
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          input: { path: "/repo/package.json", content: "visible" },
          output: { bytes: 12, content: "visible" },
        });
        return { value: "output" };
      },
    });

    await runCompiledWorkflow(compiled);

    expect(
      events.find((event) => event.type === "invocation.activity"),
    ).toEqual(
      expect.objectContaining({
        input: {
          state: "present",
          value: { path: "/repo/package.json", content: "visible" },
        },
        output: {
          state: "present",
          value: { bytes: 12, content: "visible" },
        },
      }),
    );
  });

  it("emits skill activity with full metadata and timing", async () => {
    const events: SeqlaneEvent[] = [];
    const taskDefinition: TaskDefinition = {
      id: "a",
      input: z.unknown(),
      output: z.unknown(),
      execute: async ({ context }) => context.runAgent({ goal: "test" }),
    };
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      taskDefinitions: new Map([["a", taskDefinition]]),
      taskSchemas: new Map([["a", taskDefinition]]),
      executor: async ({ onActivity }) => {
        onActivity?.({
          activityId: "skill-call-1",
          kind: "skill",
          name: "web-perf",
          state: "succeeded",
          metadata: {
            name: "web-perf",
            dir: "/repo/.agents/skills/web-perf",
          },
          startedAt: 100,
          endedAt: 125,
        });
        return { value: "output" };
      },
    });

    await runCompiledWorkflow(compiled);

    expect(
      events.find((event) => event.type === "invocation.activity"),
    ).toEqual(
      expect.objectContaining({
        kind: "skill",
        name: "web-perf",
        activityMetadata: {
          state: "present",
          value: {
            name: "web-perf",
            dir: "/repo/.agents/skills/web-perf",
          },
        },
        startedAt: 100,
        endedAt: 125,
      }),
    );
  });

  it("emits full input and result values in lifecycle order", async () => {
    const events: SeqlaneEvent[] = [];
    const taskDefinition: TaskDefinition = {
      id: "a",
      input: z.unknown(),
      output: z.unknown(),
      execute: async ({ context }) => context.runAgent({ goal: "test" }),
    };
    const compiled = compile(
      plan([
        task("a", [], {
          value: { type: "ref", nodeId: "__seqlane_input", path: ["value"] },
        }),
      ]),
      {
        events: { emit: (event) => events.push(event) },
        taskDefinitions: new Map([["a", taskDefinition]]),
        taskSchemas: new Map([["a", taskDefinition]]),
        executor: async () => ({ value: "safe", secret: "hidden" }),
      },
    );

    await runCompiledWorkflow(compiled);

    const input = events.find((event) => event.type === "invocation.input");
    const result = events.find((event) => event.type === "invocation.result");
    expect(input).toEqual({
      type: "invocation.input",
      workId: "test-work",
      runId: "run-1",
      invocationId: "a",
      input: { state: "present", value: { value: "input" } },
    });
    expect(result).toEqual({
      type: "invocation.result",
      workId: "test-work",
      runId: "run-1",
      invocationId: "a",
      result: { state: "present", value: { value: "safe", secret: "hidden" } },
    });
    expect(events.indexOf(input!)).toBeLessThan(events.indexOf(result!));
    expect(
      events.findIndex(({ type }) => type === "invocation.succeeded"),
    ).toBeGreaterThan(events.indexOf(result!));
  });

  const expectedFailures: ReadonlyArray<
    readonly [
      string,
      InputValidationError | ExecutorError | OutputValidationError,
    ]
  > = [
    ["input validation", new InputValidationError("a", new Error("bad input"))],
    ["executor failure", new ExecutorError("a", new Error("executor failed"))],
    [
      "output validation",
      new OutputValidationError("a", new Error("bad output")),
    ],
  ];

  it.each(expectedFailures)(
    "normalizes %s failures in invocation and run outcomes",
    async (_label, expectedError) => {
      const events: SeqlaneEvent[] = [];
      const source = plan([task("a")]);
      const taskSchemas = new Map<string, TaskSchema>();
      let executorCalls = 0;
      let taskBodyCalls = 0;
      let taskDefinitions: ReadonlyMap<string, TaskDefinition> | undefined;
      let executor:
        ((request: ExecutorRequest) => Promise<unknown>) | undefined;

      if (expectedError instanceof InputValidationError) {
        taskSchemas.set("a", {
          input: throwingSchema("bad input"),
          output: z.unknown(),
        });
        taskDefinitions = new Map([
          [
            "a",
            {
              id: "a",
              input: z.unknown(),
              output: z.unknown(),
              execute: async () => {
                taskBodyCalls += 1;
                return { value: "unexpected" };
              },
            },
          ],
        ]);
      } else if (expectedError instanceof OutputValidationError) {
        taskSchemas.set("a", {
          input: z.unknown(),
          output: throwingSchema("bad output"),
        });
      } else {
        executor = async () => {
          executorCalls += 1;
          throw new Error("executor failed");
        };
      }

      if (expectedError instanceof InputValidationError) {
        executor = async () => {
          executorCalls += 1;
          return { value: "unexpected" };
        };
      }

      const compiled = compile(source, {
        events: { emit: (event) => events.push(event) },
        executor,
        taskSchemas,
        taskDefinitions,
      });
      const outcome = await runCompiledWorkflow(compiled);

      expect(outcome.status).toBe("failed");
      expect(
        (outcome as Extract<SeqlaneRunOutcome, { status: "failed" }>).error,
      ).toBeInstanceOf(expectedError.constructor);
      expect(events[0]).toEqual({
        type: "run.started",
        workId: "test-work",
        runId: "run-1",
      });
      if (expectedError instanceof InputValidationError) {
        expect(executorCalls).toBe(0);
        expect(taskBodyCalls).toBe(0);
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: "invocation.started" }),
        );
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: "invocation.input" }),
        );
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: "invocation.output" }),
        );
      } else {
        expect(
          events.find(({ type }) => type === "invocation.started"),
        ).toMatchObject({
          type: "invocation.started",
          workId: "test-work",
          runId: "run-1",
          invocationId: "a",
          taskId: "a",
        });
      }
      expect(
        events.find(({ type }) => type === "invocation.failed"),
      ).toMatchObject({
        type: "invocation.failed",
        workId: "test-work",
        runId: "run-1",
        invocationId: "a",
        error: expectedError,
        disposition: "fail_run",
      });
      expect(events.find(({ type }) => type === "run.failed")).toMatchObject({
        type: "run.failed",
        workId: "test-work",
        runId: "run-1",
      });
      expectOneTerminalPerCreatedInvocation(events);
    },
  );

  it("stops the run and does not execute downstream invocations after failure", async () => {
    const calls: string[] = [];
    const compiled = compile(
      plan([task("downstream", ["upstream"]), task("upstream")]),
      {
        executor: async ({ invocationId }) => {
          calls.push(invocationId);
          if (invocationId === "upstream") {
            throw new Error("upstream failed");
          }
          return { value: "unexpected" };
        },
      },
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<SeqlaneRunOutcome, { status: "failed" }>).error,
    ).toBeInstanceOf(ExecutorError);
    expect(calls).toEqual(["upstream"]);
  });

  it("normalizes an interaction requirement as a safe executor failure", async () => {
    const calls: string[] = [];
    const events: SeqlaneEvent[] = [];
    const compiled = compile(
      plan([task("downstream", ["interaction"]), task("interaction")]),
      {
        events: { emit: (event) => events.push(event) },
        executor: async ({ invocationId }) => {
          calls.push(invocationId);
          if (invocationId === "interaction") {
            const error = new InteractionRequiredError("user-input");
            Object.defineProperty(error, "rawRequest", {
              value: { prompt: "approve this private operation" },
            });
            throw error;
          }
          return { value: "unexpected" };
        },
      },
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    const error = (outcome as Extract<SeqlaneRunOutcome, { status: "failed" }>)
      .error;
    expect(error).toBeInstanceOf(ExecutorError);
    expect(error).toMatchObject({
      category: "ExecutorError",
      taskId: "interaction",
      message:
        'Task executor failed for "interaction": Seqlane execution requires human interaction',
    });
    expect(error).not.toHaveProperty("rawRequest");
    expect(calls).toEqual(["interaction"]);
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "invocation.created",
      "invocation.created",
      "invocation.progress",
      "invocation.progress",
      "invocation.started",
      "invocation.progress",
      "invocation.output",
      "invocation.input",
      "invocation.failed",
      "invocation.progress",
      "invocation.skipped",
      "run.failed",
    ]);
    expect(events).toContainEqual({
      type: "invocation.skipped",
      workId: "test-work",
      runId: "run-1",
      invocationId: "downstream",
      reason: "dependency failed",
      dependencyIds: ["interaction"],
    });
    expectOneTerminalPerCreatedInvocation(events);
  });

  it("attempts a failed executor exactly once", async () => {
    let attempts = 0;
    const compiled = compile(plan([task("a")]), {
      executor: async () => {
        attempts += 1;
        throw new Error("executor failed");
      },
    });

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect(attempts).toBe(1);
  });

  it("emits heartbeats while work is active", async () => {
    const events: SeqlaneEvent[] = [];
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { value: "output" };
      },
    });

    await startCompiledWorkflow(compiled, { heartbeatIntervalMs: 1 }).outcome;

    expect(events.some(({ type }) => type === "run.heartbeat")).toBe(true);
  });

  it("fails on heartbeat delivery errors after the active executor cleans up", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cleanedUp = false;
    const heartbeatFailure = new Error("heartbeat sink failed");
    const compiled = compile(plan([task("active")]), {
      events: {
        emit: (event) => {
          if (event.type === "run.heartbeat") throw heartbeatFailure;
        },
      },
      executor: async ({ signal }) => {
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        cleanedUp = true;
        return { value: "cancelled" };
      },
    });

    const outcomePromise = startCompiledWorkflow(compiled, {
      heartbeatIntervalMs: 1,
    }).outcome;
    await started;
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(cleanedUp).toBe(true);
    expect(outcome.error.cause).toBe(heartbeatFailure);
  });

  it("publishes invocation topology while model preflight is still pending", async () => {
    let markPreflightStarted!: () => void;
    let releasePreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const events: SeqlaneEvent[] = [];
    let taskStarted = false;
    const selectedModel = {
      model: { provider: "test", model: "held-preflight" },
      reasoning: "medium" as const,
    };
    const taskNode = task("held-preflight") as Extract<
      PlanNode,
      { type: "task" }
    >;
    const compiled = compile(
      plan([{ ...taskNode, session: { type: "isolated" } }]),
      {
        events: { emit: (event) => events.push(event) },
        executor: async () => {
          taskStarted = true;
          return { value: "unexpected" };
        },
        sessionResolver: {
          adapterCapabilities: {
            execute: true,
            modelSelection: true,
            structuredOutput: true,
            sessionReuse: true,
            checkpoint: true,
            fork: true,
            activity: true,
            sessionUi: true,
          },
          modelCapabilities: {
            executor: "test-executor",
            resolveDefaultModel: async () => selectedModel,
            listModels: async () => {
              markPreflightStarted();
              await preflightGate;
              return [];
            },
          },
          resolve: async () => {
            throw new Error("Session resolution must follow model preflight");
          },
        },
      },
    );

    const outcomePromise = startCompiledWorkflow(compiled).outcome;
    try {
      await preflightStarted;
      expect(events.some((event) => event.type === "invocation.created")).toBe(
        true,
      );
      expect(taskStarted).toBe(false);
    } finally {
      releasePreflight();
    }
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("failed");
    expect(taskStarted).toBe(false);
  });

  it("cancels an active run and aborts the executor", async () => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const executorAborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const events: SeqlaneEvent[] = [];
    const compiled = compile(plan([task("a")]), {
      events: { emit: (event) => events.push(event) },
      executor: async ({ signal }) => {
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            markAborted();
            reject(new Error("executor aborted"));
          };
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        });
        return { value: "unreachable" };
      },
    });

    const activeRun = startCompiledWorkflow(compiled);
    await executorStarted;
    await activeRun.cancel();
    await executorAborted;

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "invocation.created",
      "invocation.progress",
      "invocation.started",
      "invocation.progress",
      "invocation.output",
      "invocation.input",
      "invocation.progress",
      "invocation.cancelled",
      "run.cancelled",
    ]);
    expect(events).toContainEqual({
      type: "invocation.cancelled",
      workId: "test-work",
      runId: "run-1",
      invocationId: "a",
      reason: "Run cancelled during invocation execution",
    });
    expectOneTerminalPerCreatedInvocation(events);
  });

  it("latches cancellation before the in-process run starts", async () => {
    let started = false;
    const compiled = compile(plan([task("a")]), {
      executor: async () => {
        started = true;
        return { value: "unexpected" };
      },
    });
    const activeRun = startCompiledWorkflow(compiled);
    await activeRun.cancel();

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(started).toBe(false);
  });

  it("maps an unexpected in-process program failure to RuntimeError", async () => {
    const compiled = compile(plan([task("a")]));
    const failedProgram = createSequentialProgram({
      steps: [
        {
          id: "failed-step",
          execute: async () => {
            throw new Error("unexpected program failure");
          },
        },
      ],
    });

    const outcome = await runCompiledWorkflow({
      ...compiled,
      program: failedProgram,
    });

    expect(outcome.status).toBe("failed");
    expect(
      (outcome as Extract<SeqlaneRunOutcome, { status: "failed" }>).error,
    ).toBeInstanceOf(RuntimeError);
    expect(
      (outcome as Extract<SeqlaneRunOutcome, { status: "failed" }>).error,
    ).not.toHaveProperty("result");
  });
});
