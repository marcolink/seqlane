// @test-scope ./run.ts
// @test-scope ./main.ts
// @test-scope ../runtime/plan/agent-work.ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { decodeSeqlaneExecutionEvent } from "@seqlane/events";
import {
  requestRunnerCancellation,
  startRun,
  type RunnerHost,
  type RunnerRunControl,
} from "./run.js";
import { planContainsAgentWork } from "../runtime/plan/agent-work.js";
import { bindRunnerCancellationSignals, startRunnerProcess } from "./main.js";
import type { Plan, RunRequest, TaskDefinitionRegistry } from "@seqlane/core";
import type {
  ResolvedExecutorSession,
  SessionResolver,
} from "../runtime/session/session-resolution.js";

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
  it("detects agent work inside repeat bodies", () => {
    const task = (execution: "agent" | "local") => ({
      type: "task" as const,
      taskId: execution,
      nodeId: execution,
      workspace: "shared" as const,
      execution,
      input: {},
      dependsOn: [],
    });
    const repeat = {
      type: "repeat" as const,
      nodeId: "repeat:1",
      input: {},
      dependsOn: [],
      maximumIterations: 1,
      body: {
        inputNodeId: "repeat:1:input",
        nodes: [task("agent")],
        output: {},
        until: { type: "ref" as const, nodeId: "repeat:1:input", path: [] },
      },
    };

    expect(
      planContainsAgentWork({
        workflow: { id: "local" },
        nodes: [
          {
            ...repeat,
            body: { ...repeat.body, nodes: [task("local")] },
          },
        ],
        output: {},
      } as Plan),
    ).toBe(false);
    expect(
      planContainsAgentWork({
        workflow: { id: "agent" },
        nodes: [repeat],
        output: {},
      } as Plan),
    ).toBe(true);
  });

  it("is safe to call outside a child process with IPC", () => {
    expect(() => startRunnerProcess()).not.toThrow();
  });

  it("cancels the active run when the runner receives a termination signal", async () => {
    const signals = new FakeRunnerSignalSource();
    const controller = new AbortController();
    let cancellations = 0;
    const control: RunnerRunControl = {
      cancellationRequested: false,
      abortController: controller,
      activeRun: {
        workId: "work-id",
        runId: "run-id",
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

  it("aborts the setup signal passed to the runner-execution factory", async () => {
    const moduleSource = `
      export const workflow = {
        workflow: { id: "setup-cancellation" },
        nodes: [],
        output: null,
      };
    `;
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "setup-cancellation",
        moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
    expect(host.events).toHaveLength(2);
    expect(host.events[0]).toMatchObject({
      type: "run.started",
      workId: "work-1",
      runId: "run-1",
      metadata: { schemaVersion: 1, sequence: 1 },
    });
    expect(host.events[1]).toMatchObject({
      type: "run.cancelled",
      workId: "work-1",
      runId: "run-1",
      metadata: { schemaVersion: 1, sequence: 2 },
    });
  });

  it("emits one Plan event before invocation topology", async () => {
    const moduleSource = `
      export const workflow = {
        workflow: { id: "plan-run", version: "1" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: { secret: "must-not-cross-runner" },
          dependsOn: []
        }],
        output: { type: "ref", nodeId: "task:1", path: ["output"] }
      };
    `;
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "plan-run",
        moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
          workspace: "shared",
          input: { parse: (value) => value },
          output: { parse: (value) => value },
          goal: () => "complete the task",
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
    const moduleSource = `
      export const workflow = {
        workflow: { id: "dry-run" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: {},
          dependsOn: []
        }],
        output: { type: "ref", nodeId: "task:1", path: [] }
      };
    `;
    const host = new FakeRunnerHost();
    let runtimeResolved = false;

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "dry-run",
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
    const moduleSource = `
      export const workflow = {
        workflow: { id: "write-workspace" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "exclusive",
          input: {},
          dependsOn: []
        }],
        output: { type: "ref", nodeId: "task:1", path: [] }
      };
    `;
    const request: RunRequest = {
      type: "run.start",
      workflow: {
        id: "write-workspace",
        moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
          workspace: "exclusive",
          input: { parse: (value) => value },
          output: { parse: (value) => value },
          goal: () => "modify the workspace",
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
    const moduleSource = `
      export const workflow = {
        workflow: { id: "unsupported-read" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: {},
          dependsOn: []
        }],
        output: { type: "ref", nodeId: "task:1", path: [] }
      };
    `;
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          workspace: "shared",
          input: { parse: (value) => value },
          output: { parse: (value) => value },
          goal: () => "inspect the workspace",
        },
      ],
    ]);
    const executor = { execute: async () => ({ result: "done" }) };
    let sessionResolved = false;
    const host = new FakeRunnerHost();

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "unsupported-read",
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
    const moduleSource = `
      export const workflow = {
        workflow: { id: "session-resolution" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: {},
          dependsOn: []
        }],
        output: { type: "ref", nodeId: "task:1", path: [] }
      };
    `;
    const taskDefinitions: TaskDefinitionRegistry = new Map([
      [
        "task",
        {
          id: "task",
          workspace: "shared",
          input: { parse: (value) => value },
          output: { parse: (value) => value },
          goal: () => "complete the task",
        },
      ],
    ]);
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };
    let resolved = false;
    let executed = false;

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "session-resolution",
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
    const moduleSource = `
      export const workflow = {
        workflow: { id: "invalid-run" },
        nodes: [{
          type: "task",
          nodeId: "task:1",
          taskId: "task",
          workspace: "shared",
          input: null,
          dependsOn: ["task:1"]
        }],
        output: { type: "ref", nodeId: "task:1", path: ["output"] }
      };
    `;
    const host = new FakeRunnerHost();
    const control: RunnerRunControl = { cancellationRequested: false };

    await startRun(
      host,
      {
        type: "run.start",
        workflow: {
          id: "invalid-run",
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
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
