// @test-scope ./run.ts
// @test-scope ./main.ts
// @test-scope ../runtime/plan/agent-work.ts
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodeSeqlaneExecutionEvent } from "@seqlane/protocol";
import {
  requestRunnerCancellation,
  startRun,
  type RunnerHost,
  type RunnerRunControl,
} from "./run.js";
import {
  bindRunnerCancellationSignals,
  bindRunnerSupervisorDisconnect,
  createRunnerExecutionResolver,
  startRunnerProcess,
} from "./main.js";
import { createFlow, type TaskDefinitionRegistry } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import type {
  ResolvedExecutorSession,
  SessionResolver,
} from "../runtime/session/session-resolution.js";
import type { LoadedWorkflow } from "./workflow/load-workflow.js";

const loadWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock("./workflow/load-workflow.js", () => ({
  loadWorkflow: loadWorkflowMock,
}));

afterEach(() => {
  loadWorkflowMock.mockReset();
});

function useLoadedWorkflow(
  plan: LoadedWorkflow["plan"],
  taskDefinitions: TaskDefinitionRegistry = new Map(),
): void {
  const schema = z.unknown();
  const workflow = createFlow({
    id: plan.workflow.id,
    input: schema,
    output: schema,
  })
    .output(() => null)
    .define();
  loadWorkflowMock.mockResolvedValue({
    reference: {
      id: plan.workflow.id,
      moduleSpecifier: "test:workflow",
      exportName: "workflow",
    },
    workflow,
    plan,
    taskDefinitions,
    validatorDefinitions: new Map(),
    workflowDefinitions: new Map(),
  } satisfies LoadedWorkflow);
}

function sharedSessionResolver(
  executor: ResolvedExecutorSession["executor"],
): SessionResolver {
  const shared = { key: Symbol("test-shared-session"), executor };
  return { resolve: async () => shared };
}

class FakeRunnerHost implements RunnerHost {
  readonly events: unknown[] = [];
  exitCode: number | undefined;

  on(): this {
    return this;
  }

  send(message: string, callback?: (error?: Error) => void): boolean {
    this.events.push(decodeSeqlaneExecutionEvent(message));
    callback?.();
    return true;
  }

  exit(code = 0): never {
    this.exitCode = code;
    return undefined as never;
  }
}

class FakeRunnerSignalSource extends EventEmitter {
  override on(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(signal, listener);
  }

  emitSignal(signal: "SIGINT" | "SIGTERM"): void {
    this.emit(signal);
  }
}

describe("seqlane runner entry point", () => {
  it("is safe to call outside a child process with IPC", () => {
    expect(() => startRunnerProcess()).not.toThrow();
  });

  it("uses composition-owned agent runtime only for agent worker profiles", async () => {
    const agentRuntimeFactory = vi.fn(async () => ({
      identity: "fixture",
      capabilities: {
        execute: true as const,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("adapter creation is not expected during setup");
      },
      redactAdapter: (adapter: never) => adapter,
    }));
    const createAgentRuntimeFactory = vi.fn(() => agentRuntimeFactory);
    const resolver = createRunnerExecutionResolver({
      createAgentRuntimeFactory,
    });
    const definitions = new Map();
    const signal = new AbortController().signal;

    const local = await resolver({ id: "local" }, definitions, signal, null);
    await local.close?.();
    expect(createAgentRuntimeFactory).not.toHaveBeenCalled();

    const agent = await resolver({ id: "fixture" }, definitions, signal, null);
    await agent.close?.();
    expect(createAgentRuntimeFactory).toHaveBeenCalledTimes(1);
    expect(agentRuntimeFactory).toHaveBeenCalledTimes(1);
  });

  it("cancels the active run when the runner receives a termination signal", async () => {
    const signals = new FakeRunnerSignalSource();
    const controller = new AbortController();
    let cancellations = 0;
    const control: RunnerRunControl = {
      cancellationRequested: false,
      abortController: controller,
      activeRun: {
        outcome: Promise.resolve({ status: "cancelled" }),
        cancel: async () => {
          cancellations += 1;
        },
      },
    };

    bindRunnerCancellationSignals(signals, control);
    signals.emitSignal("SIGINT");
    signals.emitSignal("SIGTERM");

    expect(control.cancellationRequested).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(cancellations).toBe(1);
  });

  it("cancels active work when its CLI supervisor disconnects", async () => {
    const supervisor = new EventEmitter();
    const controller = new AbortController();
    let cancellations = 0;
    const control: RunnerRunControl = {
      cancellationRequested: false,
      abortController: controller,
      activeRun: {
        outcome: Promise.resolve({ status: "cancelled" }),
        cancel: async () => {
          cancellations += 1;
        },
      },
    };

    bindRunnerSupervisorDisconnect(supervisor, control);
    supervisor.emit("disconnect");
    await Promise.resolve();

    expect(control.cancellationRequested).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(cancellations).toBe(1);
  });

  it("aborts the setup signal passed to the runner-execution factory", async () => {
    useLoadedWorkflow({
      workflow: { id: "setup-cancellation" },
      nodes: [],
      output: null,
    });
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "setup-cancellation",
        moduleSpecifier: "test:setup-cancellation",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "http://127.0.0.1:4096" },
    };
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    const run = startRun(
      host,
      request,
      () => "work-1",
      () => "run-1",
      () => undefined,
      control,
      async (_profile, taskDefinitions, signal) => {
        const executor = { execute: async () => null };
        (globalThis as Record<string, unknown>).__seqlaneSetupSignal = signal;
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("setup aborted")),
            { once: true },
          );
        });
        return {
          executors: {
            agent: () => executor,
          },
          sessionResolver: sharedSessionResolver(executor),
          taskDefinitions: taskDefinitions!,
          workspaceIdentities: new Map(),
          workspaceResources: new Map(),
        };
      },
    );

    while (!(globalThis as Record<string, unknown>).__seqlaneSetupSignal) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    requestRunnerCancellation(control);
    await run;

    expect(
      (globalThis as Record<string, unknown>).__seqlaneSetupSignal,
    ).toMatchObject({ aborted: true });
    delete (globalThis as Record<string, unknown>).__seqlaneSetupSignal;
    expect(host.events).toHaveLength(3);
    expect(host.events[0]).toMatchObject({
      type: "run.started",
      workId: "work-1",
      runId: "run-1",
      metadata: { schemaVersion: 1, sequence: 1 },
    });
    expect(host.events[1]).toMatchObject({ type: "run.plan" });
    expect(host.events[2]).toMatchObject({
      type: "run.cancelled",
      workId: "work-1",
      runId: "run-1",
      metadata: { schemaVersion: 1, sequence: 3 },
    });
  });

  it("passes the workflow run identity into runtime profile resolution", async () => {
    useLoadedWorkflow({
      workflow: { id: "run-identity" },
      nodes: [],
      output: null,
    });
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "run-identity",
        moduleSpecifier: "test:run-identity",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "test" },
    };
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    let resolvedRunId: string | undefined;
    let closed = false;

    await startRun(
      host,
      request,
      () => "work-identity",
      () => "run-identity",
      () => undefined,
      control,
      async (_profile, taskDefinitions, _signal, _input, _notify, options) => {
        resolvedRunId = options?.runId;
        const executor = { execute: async () => null };
        return {
          executors: { agent: () => executor },
          sessionResolver: sharedSessionResolver(executor),
          taskDefinitions: taskDefinitions!,
          workspaceIdentities: new Map(),
          workspaceResources: new Map(),
          close: async () => {
            closed = true;
          },
        };
      },
    );

    expect(resolvedRunId).toBe("run-identity");
    expect(closed).toBe(true);
  });

  it("closes a prepared runtime and exits when its supervisor disconnects", async () => {
    useLoadedWorkflow({
      workflow: { id: "cancel-before-execution" },
      nodes: [],
      output: null,
    });
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "cancel-before-execution",
        moduleSpecifier: "test:cancel-before-execution",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "test" },
    };
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    const supervisor = new EventEmitter();
    bindRunnerSupervisorDisconnect(supervisor, control);
    let closed = 0;

    await startRun(
      host,
      request,
      () => "work-1",
      () => "run-1",
      () => undefined,
      control,
      async (_profile, taskDefinitions) => {
        supervisor.emit("disconnect");
        const executor = { execute: async () => null };
        return {
          executors: { agent: () => executor },
          sessionResolver: sharedSessionResolver(executor),
          taskDefinitions: taskDefinitions!,
          workspaceIdentities: new Map(),
          workspaceResources: new Map(),
          close: async () => {
            closed += 1;
          },
        };
      },
    );

    expect(closed).toBe(1);
    expect(host.events.at(-1)).toMatchObject({ type: "run.cancelled" });
    expect(host.exitCode).toBe(0);
  });

  it("emits one Plan event before invocation topology", async () => {
    const plan = {
      workflow: { id: "plan-run", version: "1" },
      nodes: [
        {
          type: "task" as const,
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared" as const,
          input: { secret: "must-not-cross-runner" },
          dependsOn: [],
        },
      ],
      output: { type: "ref" as const, nodeId: "task:1", path: ["output"] },
    };
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "plan-run",
        moduleSpecifier: "test:plan-run",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "test" },
    };
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          input: z.unknown(),
          output: z.unknown(),
          execute: async ({ context }) =>
            context.runAgent({ goal: "complete the task" }),
        },
      ],
    ]);
    const executor: ResolvedExecutorSession["executor"] = {
      execute: async ({ onMetrics, onDiagnostic }) => {
        onMetrics?.({ durationMs: 1 });
        onDiagnostic?.("Using prompt-based structured output");
        return { result: "done" };
      },
    };
    useLoadedWorkflow(plan, taskDefinitions);

    await startRun(
      host,
      request,
      () => "work-1",
      () => "run-1",
      () => undefined,
      control,
      async () => ({
        executors: {
          agent: () => executor,
        },
        sessionResolver: sharedSessionResolver(executor),
        taskDefinitions,
        workspaceIdentities: new Map(),
        workspaceResources: new Map(),
      }),
      () => "invocation-1",
    );

    const eventTypes = host.events.map(
      (event) => (event as { type: string }).type,
    );
    expect(eventTypes.indexOf("run.plan")).toBeGreaterThan(-1);
    expect(eventTypes.indexOf("run.plan")).toBeLessThan(
      eventTypes.indexOf("invocation.created"),
    );
    expect(
      host.events.filter(
        (event) => (event as { type: string }).type === "run.plan",
      ),
    ).toHaveLength(1);
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "invocation.result",
        result: { state: "present", value: { result: "done" } },
      }),
    );
    expect(
      host.events.find(
        (event) => (event as { type: string }).type === "invocation.result",
      ),
    ).not.toHaveProperty("metrics");
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        metrics: { durationMs: 1 },
      }),
    );
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        channel: "task",
        content: "Using prompt-based structured output",
      }),
    );
    expect(
      host.events.find(
        (event) => (event as { type: string }).type === "run.plan",
      ),
    ).toMatchObject({
      type: "run.plan",
      plan: {
        workflow: { id: "plan-run", version: "1" },
        nodes: [
          {
            planNodeId: "task:1",
            type: "task",
            label: "task",
            taskId: "task",
            dependsOn: [],
            siblingOrder: 0,
          },
        ],
      },
    });
  });

  it("emits the calculated Plan without resolving runtime execution in dry-run mode", async () => {
    useLoadedWorkflow({
      workflow: { id: "dry-run" },
      nodes: [
        {
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          session: { type: "isolated" },
          input: {},
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "task:1", path: [] },
    });
    const host = new FakeRunnerHost();
    let runtimeResolved = false;

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "dry-run",
          moduleSpecifier: "test:dry-run",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "not-contacted" },
        dryRun: true,
      },
      () => "work-1",
      () => "run-1",
      () => undefined,
      { cancellationRequested: false },
      async () => {
        runtimeResolved = true;
        throw new Error("dry runs must not resolve runtime execution");
      },
    );

    expect(runtimeResolved).toBe(false);
    expect(
      host.events.map((event) => (event as { type: string }).type),
    ).toEqual(["run.started", "run.plan", "run.succeeded"]);
    expect(host.events[1]).toMatchObject({
      type: "run.plan",
      plan: {
        workflow: { id: "dry-run" },
        nodes: [
          {
            planNodeId: "task:1",
            type: "task",
            taskId: "task",
            dependsOn: [],
            siblingOrder: 0,
          },
        ],
      },
    });
  });

  it("passes a resolved workspace resource to a write invocation", async () => {
    const plan = {
      workflow: { id: "write-workspace" },
      nodes: [
        {
          type: "task" as const,
          nodeId: "task:1",
          taskId: "task",
          workspace: "exclusive" as const,
          input: {},
          dependsOn: [],
        },
      ],
      output: { type: "ref" as const, nodeId: "task:1", path: [] },
    };
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "write-workspace",
        moduleSpecifier: "test:write-workspace",
        exportName: "workflow",
      },
      input: null,
      runtime: { id: "test" },
    };
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          input: z.unknown(),
          output: z.unknown(),
          execute: async ({ context }) =>
            context.runAgent({ goal: "modify the workspace" }),
        },
      ],
    ]);
    let executed = false;
    const executor = {
      execute: async () => {
        executed = true;
        return { result: "done" };
      },
    };
    const host = new FakeRunnerHost();
    useLoadedWorkflow(plan, taskDefinitions);

    await startRun(
      host,
      request,
      () => "work-1",
      () => "run-1",
      () => undefined,
      { cancellationRequested: false },
      async () => ({
        executors: { agent: () => executor },
        sessionResolver: sharedSessionResolver(executor),
        taskDefinitions,
        workspaceIdentities: new Map([["task", { path: "/checkout" }]]),
        workspaceResources: new Map([["task", { key: "/checkout" }]]),
      }),
      () => "invocation-1",
    );

    expect(executed).toBe(true);
    expect(
      host.events.map((event) => (event as { type: string }).type),
    ).toContain("run.succeeded");
  });

  it("does not preflight task permissions before resolving a runtime session", async () => {
    const plan = {
      workflow: { id: "unsupported-read" },
      nodes: [
        {
          type: "task" as const,
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared" as const,
          session: { type: "isolated" as const },
          input: {},
          dependsOn: [],
        },
      ],
      output: { type: "ref" as const, nodeId: "task:1", path: [] },
    };
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          input: z.unknown(),
          output: z.unknown(),
          execute: async ({ context }) =>
            context.runAgent({ goal: "inspect the workspace" }),
        },
      ],
    ]);
    const executor = { execute: async () => ({ result: "done" }) };
    let sessionResolved = false;
    const host = new FakeRunnerHost();
    useLoadedWorkflow(plan, taskDefinitions);

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "unsupported-read",
          moduleSpecifier: "test:unsupported-read",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "test" },
      },
      () => "work-1",
      () => "run-1",
      () => undefined,
      { cancellationRequested: false },
      async () => ({
        executors: { agent: () => executor },
        sessionResolver: {
          resolve: async () => {
            sessionResolved = true;
            return { key: Symbol("session"), executor };
          },
        },
        taskDefinitions,
        workspaceIdentities: new Map(),
        workspaceResources: new Map(),
      }),
    );

    expect(sessionResolved).toBe(true);
    expect(host.events.at(-1)).toMatchObject({ type: "run.succeeded" });
  });

  it("resolves an invocation session before the executor runs", async () => {
    const plan = {
      workflow: { id: "session-resolution" },
      nodes: [
        {
          type: "task" as const,
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared" as const,
          session: { type: "isolated" as const },
          input: {},
          dependsOn: [],
        },
      ],
      output: { type: "ref" as const, nodeId: "task:1", path: [] },
    };
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          input: z.unknown(),
          output: z.unknown(),
          execute: async ({ context }) =>
            context.runAgent({ goal: "complete the task" }),
        },
      ],
    ]);
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    let resolved = false;
    let executed = false;
    useLoadedWorkflow(plan, taskDefinitions);

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "session-resolution",
          moduleSpecifier: "test:session-resolution",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "test" },
      },
      () => "work-1",
      () => "run-1",
      () => undefined,
      control,
      async () => ({
        executors: {
          agent: () => ({
            execute: async () => {
              throw new Error("unresolved executor");
            },
          }),
        },
        sessionResolver: {
          resolve: async () => {
            resolved = true;
            return {
              key: Symbol("session"),
              executor: {
                execute: async () => {
                  expect(resolved).toBe(true);
                  executed = true;
                  return { result: "done" };
                },
              },
            };
          },
        },
        taskDefinitions,
        workspaceIdentities: new Map(),
        workspaceResources: new Map(),
      }),
      () => "invocation-1",
    );

    expect(resolved).toBe(true);
    expect(executed).toBe(true);
  });

  it("does not emit a fabricated Plan event when loading fails", async () => {
    loadWorkflowMock.mockRejectedValue(new Error("workflow loading failed"));
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "invalid-run",
          moduleSpecifier: "test:invalid-run",
          exportName: "workflow",
        },
        input: null,
        runtime: { id: "test" },
      },
      () => "work-1",
      () => "run-1",
      () => undefined,
      control,
      async () => {
        throw new Error("execution setup must not run");
      },
    );

    expect(
      host.events.some(
        (event) => (event as { type: string }).type === "run.plan",
      ),
    ).toBe(false);
    expect(host.events.at(-1)).toMatchObject({ type: "run.failed" });
  });
});
