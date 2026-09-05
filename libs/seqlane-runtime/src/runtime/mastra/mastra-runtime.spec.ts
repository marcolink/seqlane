// @test-scope ../compile/mastra-plan-compiler.ts
// @test-scope ./mastra-runtime.ts
// @test-scope ./mastra-server.ts
// @test-scope ./mastra-execution.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Plan,
  SeqlaneEvent,
  SeqlaneSchema,
  TaskDefinition,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
} from "@seqlane/core";
import {
  ExecutorError,
  InputValidationError,
  OutputValidationError,
  ValidationFailedError,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastraRuntimeSpineWorkflow } from "../../../fixtures/mastra-runtime-spine-workflow.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import { createMastraPlanExecution } from "./mastra-execution.js";
import { emitMastraInvocationTopology } from "./mastra-execution.js";
import { createMastraRuntime, type MastraRuntime } from "./mastra-runtime.js";
import type { ExecutorRequest } from "../execution/executor.js";

const publicEntryPoint = fileURLToPath(
  new URL("../../index.ts", import.meta.url),
);

const passthroughSchema: SeqlaneSchema = {
  parse: (value) => value,
};

function taskPlan(id: string): Plan {
  return {
    workflow: { id },
    nodes: [
      {
        type: "task",
        taskId: "fixture-task",
        nodeId: "fixture-task:1",
        workspace: "shared",
        input: {},
        dependsOn: [],
      },
    ],
    output: { type: "ref", nodeId: "fixture-task:1", path: [] },
  };
}

function validationPlan(): Plan {
  return {
    workflow: { id: "fixture-validation" },
    nodes: [
      {
        type: "validation.check",
        nodeId: "validation.check:1",
        source: { type: "mechanical", validatorId: "fixture-validator" },
        input: {},
        dependsOn: [],
      },
      {
        type: "validation.gate",
        nodeId: "validation.gate:1",
        input: {},
        checkNodeId: "validation.check:1",
        policy: "fail",
        dependsOn: ["validation.check:1"],
      },
    ],
    output: { type: "ref", nodeId: "validation.gate:1", path: ["value"] },
  };
}

function dependentTaskPlan(): Plan {
  return {
    workflow: { id: "fixture-dependent" },
    nodes: [
      {
        type: "task",
        taskId: "fixture-task",
        nodeId: "fixture-upstream:1",
        workspace: "shared",
        input: {},
        dependsOn: [],
      },
      {
        type: "task",
        taskId: "fixture-task",
        nodeId: "fixture-downstream:1",
        workspace: "shared",
        input: {},
        dependsOn: ["fixture-upstream:1"],
      },
    ],
    output: { type: "ref", nodeId: "fixture-downstream:1", path: [] },
  };
}

function fixtureTaskDefinitions(
  input: SeqlaneSchema = passthroughSchema,
  output: SeqlaneSchema = passthroughSchema,
): TaskDefinitionRegistry {
  const task: TaskDefinition = {
    id: "fixture-task",
    input,
    output,
    goal: () => "Run the fixture task",
  };
  return new Map([[task.id, task]]);
}

async function runMastraPlan(options: {
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly workflow?: { input: SeqlaneSchema; output: SeqlaneSchema };
  readonly executor?: (request: ExecutorRequest) => Promise<unknown>;
  readonly events?: SeqlaneEvent[];
}) {
  const active = await startMastraPlan(options);
  return active.outcome;
}

async function startMastraPlan(options: {
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly workflow?: { input: SeqlaneSchema; output: SeqlaneSchema };
  readonly executor?: (request: ExecutorRequest) => Promise<unknown>;
  readonly events?: SeqlaneEvent[];
}) {
  const executor = {
    execute: async (request: ExecutorRequest) => options.executor?.(request),
  };
  const events = {
    emit: (event: SeqlaneEvent) => {
      options.events?.push(event);
    },
  };
  const execution = createMastraPlanExecution({
    plan: options.plan,
    workflowInput: {},
    workId: "fixture-work",
    runId: "fixture-run",
    createInvocationId: (nodeId) => nodeId ?? "fixture-invocation",
    executors: { agent: () => executor },
    sessionResolver: {
      resolve: async () => ({ key: Symbol("fixture-session"), executor }),
    },
    workspaceResources: new Map(),
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    workflow: options.workflow,
    events,
  });
  await resolveCompiledWorkflowSessions(execution.legacy);
  emitMastraInvocationTopology(execution.compiled, execution.legacy, events);
  return execution.runtime.start({
    workflowKey: options.plan.workflow.id,
    input: {},
    workId: "fixture-work",
    runId: "fixture-run",
  });
}

describe("private Mastra runtime spine", () => {
  it("executes a registered workflow and preserves run identity", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: "fixture",
        input: { fail: false },
        workId: "work-success",
        runId: "run-success",
      }),
    ).resolves.toEqual({
      status: "succeeded",
      result: {
        value: "Mastra runtime spine fixture succeeded",
        runId: "run-success",
        workId: "work-success",
      },
    });
  });

  it("enforces one workflow run per private runtime instance", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: "fixture",
        input: { fail: false },
        workId: "work-single-use",
        runId: "run-single-use",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    expect(() =>
      runtime.start({
        workflowKey: "fixture",
        input: { fail: false },
        workId: "work-second-run",
        runId: "run-second-run",
      }),
    ).toThrowError(
      new TypeError(
        "A Mastra runtime instance can execute only one workflow run",
      ),
    );
  });

  it("normalizes a Mastra workflow failure without exposing Mastra details", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    const request = {
      workflowKey: "fixture",
      input: { fail: true },
      workId: "work-failure",
      runId: "run-failure",
    } as const;
    const outcome = await runtime.run(request);

    const inspection = await runtime.inspect(request);
    expect(inspection.workflowRun).toMatchObject({
      snapshot: { status: "failed" },
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;

    expect(outcome.error).toMatchObject({
      category: "RuntimeError",
      message: "Seqlane runtime failed: Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause).toBeInstanceOf(Error);
    if (!(outcome.error.cause instanceof Error)) return;

    expect(outcome.error.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
    });
    expect(outcome.error.cause.cause).toMatchObject({
      message: "Mastra runtime spine fixture failure",
      name: "Error",
    });
  });

  it("keeps Mastra imports out of the package public entry point", () => {
    expect(readFileSync(publicEntryPoint, "utf8")).not.toContain("@mastra/");
  });

  it("does not expose a run-bound compiled Plan through MCP", async () => {
    const execution = createMastraPlanExecution({
      plan: taskPlan("fixture-plan-mcp-boundary"),
      workflowInput: {},
      workId: "fixture-work",
      runId: "fixture-run",
      createInvocationId: (nodeId) => nodeId ?? "fixture-invocation",
      executors: { agent: () => ({ execute: async () => undefined }) },
      sessionResolver: {
        resolve: async () => ({
          key: Symbol("fixture-session"),
          executor: { execute: async () => undefined },
        }),
      },
      workspaceResources: new Map(),
      events: { emit: () => undefined },
    });

    await expect(execution.runtime.server.listMcpServers()).rejects.toThrow(
      "does not expose a Mastra server",
    );
  });

  it("persists run and step spans with Seqlane correlation and deterministic trace IDs", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);
    const request = {
      workflowKey: "fixture",
      input: { fail: false },
      workId: "work-inspection",
      runId: "run-inspection",
    } as const;

    await expect(runtime.run(request)).resolves.toMatchObject({
      status: "succeeded",
    });

    const inspection = await runtime.inspect(request);
    expect(inspection.workflowRun).toMatchObject({
      run_id: request.runId,
      resourceId: request.workId,
      snapshot: { status: "success" },
    });
    expect(inspection.trace).toMatchObject({
      traceId: "b8b823647f156c1a2861e90135d57111",
      spans: expect.arrayContaining([
        expect.objectContaining({
          spanType: "workflow_run",
          metadata: expect.objectContaining({
            "seqlane.workId": request.workId,
            "seqlane.runId": request.runId,
          }),
        }),
        expect.objectContaining({
          spanType: "workflow_step",
          metadata: expect.objectContaining({
            "seqlane.workId": request.workId,
            "seqlane.runId": request.runId,
          }),
        }),
      ]),
    });
  });

  it("exposes workflows through Mastra server routes and MCP", async () => {
    const runtime = createMastraRuntime([
      { key: "fixture", workflow: mastraRuntimeSpineWorkflow },
    ]);

    const workflows = await runtime.server.listWorkflows();
    expect(workflows).toHaveProperty("fixture");

    const servers = await runtime.server.listMcpServers();
    expect(servers).toMatchObject({
      servers: [expect.objectContaining({ id: "seqlane-workflows" })],
    });

    const tools = await runtime.server.listMcpTools("seqlane-workflows");
    expect(tools).toMatchObject({
      tools: [expect.objectContaining({ name: "run_fixture" })],
    });

    const serverContext = {
      requestContext: new RequestContext([["user", { id: "fixture-user" }]]),
      abortSignal: new AbortController().signal,
    };
    const firstInvocation = await runtime.server.executeMcpTool(
      "seqlane-workflows",
      "run_fixture",
      { fail: false },
      serverContext,
    );
    expect(firstInvocation).toMatchObject({
      result: {
        status: "succeeded",
        result: {
          value: "Mastra runtime spine fixture succeeded",
          runId: expect.stringMatching(/^mcp-run-/),
          workId: expect.stringMatching(/^mcp-work-/),
        },
      },
    });

    const secondInvocation = await runtime.server.executeMcpTool(
      "seqlane-workflows",
      "run_fixture",
      { fail: false },
      serverContext,
    );
    expect(secondInvocation).toMatchObject({
      result: {
        status: "succeeded",
        result: {
          value: "Mastra runtime spine fixture succeeded",
          runId: expect.stringMatching(/^mcp-run-/),
          workId: expect.stringMatching(/^mcp-work-/),
        },
      },
    });
    expect(
      (firstInvocation as { result: { result: { runId: string } } }).result
        .result.runId,
    ).not.toBe(
      (secondInvocation as { result: { result: { runId: string } } }).result
        .result.runId,
    );
  });

  it("rejects malformed MCP tool input through Mastra validation", async () => {
    let executions = 0;
    const step = createStep({
      id: "validated-fixture-step",
      inputSchema: z.object({ fail: z.boolean() }),
      outputSchema: z.object({ value: z.string() }),
      execute: async () => {
        executions += 1;
        return { value: "executed" };
      },
    });
    const workflow = createWorkflow({
      id: "validated-fixture",
      description: "Validates MCP input without executing malformed calls.",
      inputSchema: z.object({ fail: z.boolean() }),
      outputSchema: z.object({ value: z.string() }),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: "fixture", workflow }]);

    await expect(
      runtime.server.executeMcpTool(
        "seqlane-workflows",
        "run_fixture",
        {
          fail: "not-a-boolean",
        },
        {
          requestContext: new RequestContext([
            ["user", { id: "fixture-user" }],
          ]),
          abortSignal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      result: {
        error: true,
        message: expect.stringContaining("Tool validation failed"),
      },
    });
    expect(executions).toBe(0);
  });

  it("propagates MCP cancellation into the canonical Mastra run", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const step = createStep({
      id: "mcp-cancellable-step",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new Error("MCP step aborted")),
            { once: true },
          );
        });
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "mcp-cancellable-workflow",
      description: "Runs the MCP cancellation fixture.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
    const controller = new AbortController();
    const invocation = runtime.server.executeMcpTool(
      "seqlane-workflows",
      `run_${workflow.id}`,
      null,
      {
        requestContext: new RequestContext([["user", { id: "fixture-user" }]]),
        abortSignal: controller.signal,
      },
    );

    await startedPromise;
    controller.abort();

    await expect(invocation).resolves.toMatchObject({
      result: { status: "cancelled" },
    });
  });

  it("runs MCP invocations through the canonical runtime identity hook", async () => {
    const requests: Array<{ workId: string; runId: string }> = [];
    const runtime = createMastraRuntime(
      [{ key: "fixture", workflow: mastraRuntimeSpineWorkflow }],
      {
        onWorkflowResult: (request) => {
          requests.push({ workId: request.workId, runId: request.runId });
        },
      },
    );

    await runtime.server.executeMcpTool(
      "seqlane-workflows",
      "run_fixture",
      { fail: false },
      {
        requestContext: new RequestContext([["user", { id: "fixture-user" }]]),
        abortSignal: new AbortController().signal,
      },
    );

    expect(requests).toEqual([
      {
        workId: expect.stringMatching(/^mcp-work-/),
        runId: expect.stringMatching(/^mcp-run-/),
      },
    ]);
  });

  it("bounds concurrent MCP workflow dispatch", async () => {
    let active = 0;
    let maximumActive = 0;
    let invocationCount = 0;
    const startedResolvers: Array<() => void> = [];
    const started = [
      new Promise<void>((resolve) => startedResolvers.push(resolve)),
      new Promise<void>((resolve) => startedResolvers.push(resolve)),
    ];
    const releases: Array<() => void> = [];
    const step = createStep({
      id: "mcp-bounded-step",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        const index = invocationCount++;
        startedResolvers[index]?.();
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise<void>((resolve, reject) => {
            releases[index] = resolve;
            abortSignal.addEventListener(
              "abort",
              () => reject(new Error("bounded MCP invocation aborted")),
              { once: true },
            );
          });
        } finally {
          active -= 1;
        }
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "mcp-bounded-workflow",
      description: "Runs the bounded MCP fixture.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }], {
      mcpDispatcher: { maxConcurrent: 1, maxQueued: 1, deadlineMs: 1_000 },
    });
    const requestContext = () =>
      new RequestContext([["user", { id: "fixture-user" }]]);
    const first = runtime.server.executeMcpTool(
      "seqlane-workflows",
      `run_${workflow.id}`,
      null,
      {
        requestContext: requestContext(),
        abortSignal: new AbortController().signal,
      },
    );
    await started[0];
    const second = runtime.server.executeMcpTool(
      "seqlane-workflows",
      `run_${workflow.id}`,
      null,
      {
        requestContext: requestContext(),
        abortSignal: new AbortController().signal,
      },
    );
    await Promise.resolve();
    expect(invocationCount).toBe(1);

    releases[0]!();
    await started[1];
    releases[1]!();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maximumActive).toBe(1);
  });

  it("cancels MCP workflow dispatch at its deadline", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const workflow = createWorkflow({
      id: "mcp-deadline-workflow",
      description: "Runs the MCP deadline fixture.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(
        createStep({
          id: "mcp-deadline-step",
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          execute: async ({ abortSignal }) => {
            started();
            await new Promise<never>((_resolve, reject) => {
              abortSignal.addEventListener(
                "abort",
                () => reject(new Error("deadline reached")),
                { once: true },
              );
            });
            return null;
          },
        }),
      )
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }], {
      mcpDispatcher: { deadlineMs: 10 },
    });
    const invocation = runtime.server.executeMcpTool(
      "seqlane-workflows",
      `run_${workflow.id}`,
      null,
      {
        requestContext: new RequestContext([["user", { id: "fixture-user" }]]),
        abortSignal: new AbortController().signal,
      },
    );

    await startedPromise;
    await expect(invocation).resolves.toMatchObject({
      result: { status: "cancelled" },
    });
  });

  it("rejects workflows without descriptions before MCP registration", () => {
    const workflow = createWorkflow({
      id: "undocumented-fixture",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();

    expect(() => createMastraRuntime([{ key: "fixture", workflow }])).toThrow(
      /must define a non-empty description/,
    );
  });

  it("normalizes cancellation from an active Mastra run", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const step = createStep({
      id: "cancellable",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new Error("step aborted")),
            { once: true },
          );
        });
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "cancellable-workflow",
      description: "Runs the cancellable workflow fixture.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
    const active = runtime.start({
      workflowKey: workflow.id,
      input: null,
      workId: "work-cancel",
      runId: "run-cancel",
    });

    await startedPromise;
    await active.cancel();
    await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
    const inspection = await runtime.inspect({
      workflowKey: workflow.id,
      input: null,
      workId: "work-cancel",
      runId: "run-cancel",
    });
    expect(inspection.workflowRun).toMatchObject({
      snapshot: { status: "canceled" },
    });
  });

  it("waits for Mastra run creation before completing cancellation", async () => {
    let createRunStarted!: () => void;
    const createRunStartedPromise = new Promise<void>((resolve) => {
      createRunStarted = resolve;
    });
    let releaseCreateRun!: () => void;
    const createRunRelease = new Promise<void>((resolve) => {
      releaseCreateRun = resolve;
    });
    const step = createStep({
      id: "pending-create-run-step",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async () => null,
    });
    const workflow = createWorkflow({
      id: "pending-create-run-workflow",
      description: "Tests cancellation while creating a Mastra run.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const createRun = workflow.createRun.bind(workflow);
    const createRunSpy = vi
      .spyOn(workflow, "createRun")
      .mockImplementation(async (options) => {
        createRunStarted();
        await createRunRelease;
        return createRun(options);
      });

    try {
      const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
      const active = runtime.start({
        workflowKey: workflow.id,
        input: null,
        workId: "work-pending-cancel",
        runId: "run-pending-cancel",
      });

      await createRunStartedPromise;
      const firstCancellation = active.cancel();
      const secondCancellation = active.cancel();
      expect(secondCancellation).toBe(firstCancellation);

      let cancellationCompleted = false;
      void firstCancellation.then(() => {
        cancellationCompleted = true;
      });
      await Promise.resolve();
      expect(cancellationCompleted).toBe(false);

      releaseCreateRun();
      await expect(firstCancellation).resolves.toBeUndefined();
      await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
      expect(createRunSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseCreateRun();
      createRunSpy.mockRestore();
    }
  });

  it("makes repeated cancellation await one Mastra cancellation", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const step = createStep({
      id: "repeated-cancellation",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async ({ abortSignal }) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new Error("step aborted")),
            { once: true },
          );
        });
        return null;
      },
    });
    const workflow = createWorkflow({
      id: "repeated-cancellation-workflow",
      description: "Tests repeated Mastra run cancellation.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
      .then(step)
      .commit();
    const createRun = workflow.createRun.bind(workflow);
    let mastraCancelSpy!: ReturnType<typeof vi.fn>;
    const createRunSpy = vi
      .spyOn(workflow, "createRun")
      .mockImplementation(async (options) => {
        const run = await createRun(options);
        mastraCancelSpy = vi.spyOn(run, "cancel");
        return run;
      });
    const runtime = createMastraRuntime([{ key: workflow.id, workflow }]);
    const active = runtime.start({
      workflowKey: workflow.id,
      input: null,
      workId: "work-repeated-cancel",
      runId: "run-repeated-cancel",
    });

    try {
      await startedPromise;
      const firstCancellation = active.cancel();
      const secondCancellation = active.cancel();
      const thirdCancellation = active.cancel();

      expect(secondCancellation).toBe(firstCancellation);
      expect(thirdCancellation).toBe(firstCancellation);
      await expect(
        Promise.all([firstCancellation, secondCancellation, thirdCancellation]),
      ).resolves.toEqual([undefined, undefined, undefined]);
      await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
      expect(mastraCancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      createRunSpy.mockRestore();
    }
  });

  it("prefers cancellation when it races with successful completion", async () => {
    const activeRun: { current?: ReturnType<MastraRuntime["start"]> } = {};
    const runtime = createMastraRuntime(
      [{ key: "fixture", workflow: mastraRuntimeSpineWorkflow }],
      {
        onWorkflowResult: () => {
          void activeRun.current?.cancel();
        },
      },
    );

    const active = runtime.start({
      workflowKey: "fixture",
      input: { fail: false },
      workId: "work-cancel-race",
      runId: "run-cancel-race",
    });
    activeRun.current = active;

    await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("preserves typed Seqlane failures through the Mastra runner", async () => {
    const inputFailure: SeqlaneSchema = {
      parse: () => {
        throw new Error("invalid fixture input");
      },
    };
    const outputFailure: SeqlaneSchema = {
      parse: () => {
        throw new Error("invalid fixture output");
      },
    };
    const cases = [
      {
        name: "input validation",
        error: InputValidationError,
        category: "InputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-input-failure"),
        taskDefinitions: fixtureTaskDefinitions(inputFailure),
      },
      {
        name: "workflow input validation",
        error: InputValidationError,
        category: "InputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-workflow-input-failure"),
        taskDefinitions: fixtureTaskDefinitions(),
        workflow: {
          input: inputFailure,
          output: passthroughSchema,
        },
      },
      {
        name: "executor",
        error: ExecutorError,
        category: "ExecutorError",
        hasCause: true,
        plan: taskPlan("fixture-executor-failure"),
        taskDefinitions: fixtureTaskDefinitions(),
        executor: async () => {
          throw new Error("fixture executor failed");
        },
      },
      {
        name: "output validation",
        error: OutputValidationError,
        category: "OutputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-output-failure"),
        taskDefinitions: fixtureTaskDefinitions(
          passthroughSchema,
          outputFailure,
        ),
        executor: async () => ({ value: "invalid" }),
      },
      {
        name: "workflow output validation",
        error: OutputValidationError,
        category: "OutputValidationError",
        hasCause: true,
        plan: taskPlan("fixture-workflow-output-failure"),
        taskDefinitions: fixtureTaskDefinitions(),
        workflow: {
          input: passthroughSchema,
          output: outputFailure,
        },
        executor: async () => ({ value: "valid task output" }),
      },
      {
        name: "validation gate",
        error: ValidationFailedError,
        category: "ValidationError",
        hasCause: false,
        plan: validationPlan(),
        validatorDefinitions: new Map([
          [
            "fixture-validator",
            {
              id: "fixture-validator",
              input: passthroughSchema,
              validate: () => ({
                success: false as const,
                issues: [
                  { code: "rejected", message: "Fixture was rejected" },
                ] as const,
              }),
            },
          ],
        ]),
      },
    ];

    for (const testCase of cases) {
      const outcome = await runMastraPlan(testCase);

      expect(outcome.status, testCase.name).toBe("failed");
      if (outcome.status !== "failed") continue;
      expect(outcome.error, testCase.name).toBeInstanceOf(testCase.error);
      expect(outcome.error.category, testCase.name).toBe(testCase.category);
      if (testCase.hasCause) {
        expect(outcome.error.cause, testCase.name).toBeInstanceOf(Error);
      }
    }
  });

  it("emits a terminal lifecycle for compiler-level input failures", async () => {
    const events: SeqlaneEvent[] = [];
    const outcome = await runMastraPlan({
      plan: taskPlan("fixture-input-lifecycle"),
      taskDefinitions: fixtureTaskDefinitions({
        parse: () => {
          throw new Error("invalid fixture input");
        },
      }),
      events,
    });

    expect(outcome.status).toBe("failed");
    expect(events.map(({ type }) => type)).toEqual([
      "invocation.created",
      "invocation.started",
      "invocation.failed",
    ]);
    expect(events[1]).toMatchObject({
      workId: "fixture-work",
      runId: "fixture-run",
      invocationId: "fixture-task:1",
      subject: { type: "task", taskId: "fixture-task" },
    });
    expect(events[2]).toMatchObject({
      invocationId: "fixture-task:1",
      disposition: "fail_run",
    });
  });

  it("closes Mastra-skipped dependent invocations", async () => {
    const events: SeqlaneEvent[] = [];
    const outcome = await runMastraPlan({
      plan: dependentTaskPlan(),
      taskDefinitions: fixtureTaskDefinitions(),
      events,
      executor: async ({ invocationId }) => {
        if (invocationId === "fixture-upstream:1") {
          throw new Error("fixture upstream failed");
        }
        return { value: "done" };
      },
    });

    expect(outcome.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.skipped",
        invocationId: "fixture-downstream:1",
        dependencyIds: ["fixture-upstream:1"],
      }),
    );
  });

  it("cancels dependent invocations that Mastra leaves unstarted", async () => {
    const events: SeqlaneEvent[] = [];
    let executorStarted!: () => void;
    const executorStartedPromise = new Promise<void>((resolve) => {
      executorStarted = resolve;
    });
    const active = await startMastraPlan({
      plan: dependentTaskPlan(),
      taskDefinitions: fixtureTaskDefinitions(),
      events,
      executor: async ({ signal }) => {
        executorStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("fixture invocation cancelled")),
            { once: true },
          );
        });
      },
    });
    await executorStartedPromise;
    await active.cancel();

    await expect(active.outcome).resolves.toEqual({ status: "cancelled" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.cancelled",
        invocationId: "fixture-downstream:1",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "invocation.skipped",
        invocationId: "fixture-downstream:1",
        reason: expect.stringContaining("upstream failure"),
      }),
    );
  });
});
