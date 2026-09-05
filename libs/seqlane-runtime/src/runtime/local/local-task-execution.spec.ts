// @test-scope ./local-task-execution.ts
// @test-scope ./mastra-process.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../execution/model-preflight.ts
// @test-scope ../session/session-preflight.ts
// @test-scope ../workspace/workspace-lock.ts
// @test-scope ../invocation/repeat-execution.ts
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LocalTaskDefinition,
  Plan,
  SeqlaneEvent,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  TaskNode,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  OutputValidationError,
  runCompiledWorkflow,
  startCompiledWorkflow,
} from "../../index.js";
import { EffectCompiler } from "../compile/compile-plan.js";
import type { ExecutorResolvers } from "../execution/executor.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import type { SessionResolver } from "../session/session-resolution.js";

const identitySchema: SeqlaneSchema = { parse: (value) => value };

function localTaskNode(
  taskId: string,
  nodeId = `${taskId}:1`,
  workspace: "shared" | "exclusive" = "exclusive",
): TaskNode {
  return {
    type: "task",
    taskId,
    nodeId,
    workspace,
    execution: "local",
    input: { type: "ref", nodeId: "__seqlane_input", path: [] },
    dependsOn: [],
  };
}

function localPlan(
  node: TaskNode,
  output: Plan["output"] = { type: "ref", nodeId: node.nodeId, path: [] },
): Plan {
  return {
    workflow: { id: `local-${node.taskId}` },
    nodes: [node],
    output,
  };
}

function compileLocal(
  plan: Plan,
  definition: LocalTaskDefinition<unknown, unknown>,
  options: {
    readonly workspace?: string;
    readonly events?: { emit(event: SeqlaneEvent): void };
    readonly executors?: ExecutorResolvers;
    readonly sessionResolver?: SessionResolver;
    readonly taskDefinitions?: TaskDefinitionRegistry;
  } = {},
) {
  const workspace = options.workspace ?? process.cwd();
  return new EffectCompiler().compileWorkflow(plan, {
    workId: "local-work",
    runId: "local-run",
    workflowInput: { value: "input" },
    createInvocationId: (nodeId) => nodeId,
    executors: options.executors ?? {
      agent: () => ({ execute: async () => ({ unexpected: true }) }),
    },
    sessionResolver: options.sessionResolver,
    workspaceResources: new Map([[definition.id, { key: workspace }]]),
    taskDefinitions:
      options.taskDefinitions ?? new Map([[definition.id, definition]]),
    events: options.events,
  });
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

describe("local task execution", () => {
  it("passes direct command output through input and output schemas", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-local-"));
    try {
      const literalArgument = "$(not-a-shell); literal argument";
      const canonicalWorkspace = await realpath(workspace);
      const inputSchema: SeqlaneSchema<{ readonly value: string }> = {
        parse: (value) => {
          expect(value).toEqual({ value: "input" });
          return { value: "parsed-input" };
        },
      };
      const outputSchema: SeqlaneSchema = {
        parse: (value) => {
          expect(value).toMatchObject({
            exitCode: 0,
            stdout: `${canonicalWorkspace}\n${literalArgument}`,
            stderr: "stderr",
          });
          return { ...(value as object), parsed: true };
        },
      };
      const definition: LocalTaskDefinition = {
        id: "local-output",
        input: inputSchema,
        output: outputSchema,
        execute: async (input, context) => {
          const result = await context.exec({
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write(`${process.cwd()}\\n${process.argv[1]}`); process.stderr.write('stderr')",
              literalArgument,
            ],
          });
          return { ...result, input };
        },
      };
      const events: SeqlaneEvent[] = [];
      const compiled = compileLocal(
        localPlan(localTaskNode(definition.id)),
        definition,
        { workspace, events: { emit: (event) => events.push(event) } },
      );

      const outcome = await runCompiledWorkflow(compiled);
      expect(outcome).toMatchObject({
        status: "succeeded",
        result: {
          exitCode: 0,
          stdout: `${canonicalWorkspace}\n${literalArgument}`,
          stderr: "stderr",
          input: { value: "parsed-input" },
          parsed: true,
        },
      });
      expect(outcome).toMatchObject({
        status: "succeeded",
        result: {
          taskId: definition.id,
          invocationId: "local-output:1",
          outcome: "completed",
        },
      });
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
      expect(events).not.toContainEqual(
        expect.objectContaining({ metrics: expect.anything() }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([0, 23])(
    "returns a %i process exit code as task output",
    async (exitCode) => {
      const definition: LocalTaskDefinition = {
        id: `local-exit-${exitCode}`,
        input: identitySchema,
        output: identitySchema,
        execute: async (_input, context) =>
          context.exec({
            command: process.execPath,
            args: [
              "-e",
              `process.stderr.write('exit-${exitCode}'); process.exit(${exitCode})`,
            ],
          }),
      };
      const compiled = compileLocal(
        localPlan(localTaskNode(definition.id)),
        definition,
      );

      await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
        status: "succeeded",
        result: { exitCode, stderr: `exit-${exitCode}` },
      });
    },
  );

  it("maps invalid local output to OutputValidationError and does not retain it", async () => {
    const cause = new Error("invalid output");
    const definition: LocalTaskDefinition = {
      id: "local-invalid-output",
      input: identitySchema,
      output: {
        parse: () => {
          throw cause;
        },
      },
      execute: async () => ({ value: "output" }),
    };
    const compiled = compileLocal(
      localPlan(localTaskNode(definition.id)),
      definition,
    );

    const outcome = await runCompiledWorkflow(compiled);

    expect(outcome.status).toBe("failed");
    expect((outcome as { readonly error: unknown }).error).toBeInstanceOf(
      OutputValidationError,
    );
    expect(
      (outcome as unknown as { readonly error: OutputValidationError }).error
        .cause,
    ).toBe(cause);
    expect(compiled.context.results).toEqual(new Map());
  });

  it("terminates the local process before cancellation releases its workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-local-"));
    try {
      const pidPath = join(workspace, "pid");
      const definition: LocalTaskDefinition = {
        id: "local-cancel",
        input: identitySchema,
        output: identitySchema,
        execute: async (_input, context) => {
          await context.exec({
            command: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)",
              pidPath,
            ],
          });
          return {};
        },
      };
      const compiled = compileLocal(
        localPlan(localTaskNode(definition.id)),
        definition,
        { workspace },
      );
      const activeRun = startCompiledWorkflow(compiled);
      const pid = Number(await waitForFile(pidPath));

      await expect(activeRun.cancel()).resolves.toBeUndefined();
      await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
      await waitForProcessExit(pid);

      const lease = await compiled.context.workspaceLocks.acquire(
        { key: workspace },
        "exclusive",
      );
      lease.release();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("holds exclusive workspace admission across local commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-local-"));
    try {
      const markerPath = join(workspace, "second-started");
      const first: LocalTaskDefinition = {
        id: "local-first",
        input: identitySchema,
        output: identitySchema,
        execute: async (_input, context) => {
          await context.exec({
            command: process.execPath,
            args: ["-e", "setTimeout(() => undefined, 100)"],
          });
          return {};
        },
      };
      const second: LocalTaskDefinition = {
        id: "local-second",
        input: identitySchema,
        output: identitySchema,
        execute: async (_input, context) => {
          await context.exec({
            command: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], 'started')",
              markerPath,
            ],
          });
          return {};
        },
      };
      const firstNode = localTaskNode(first.id);
      const secondNode = localTaskNode(second.id);
      const compiled = new EffectCompiler().compileWorkflow(
        {
          workflow: { id: "local-admission" },
          nodes: [firstNode, secondNode],
          output: null,
        },
        {
          workflowInput: {},
          createInvocationId: (nodeId) => nodeId,
          executors: { agent: () => ({ execute: async () => ({}) }) },
          taskDefinitions: new Map([
            [first.id, first],
            [second.id, second],
          ]),
          workspaceResources: new Map([
            [first.id, { key: workspace }],
            [second.id, { key: workspace }],
          ]),
        },
      );
      const run = startCompiledWorkflow(compiled);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(readFile(markerPath, "utf8")).rejects.toThrow();
      await expect(run.outcome).resolves.toMatchObject({ status: "succeeded" });
      await expect(readFile(markerPath, "utf8")).resolves.toBe("started");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("executes local tasks in a repeat body without session resolution", async () => {
    const definition: LocalTaskDefinition = {
      id: "local-repeat",
      input: identitySchema,
      output: identitySchema,
      execute: async () => ({ complete: true }),
    };
    const repeatTaskId = "repeat:1/local-repeat:1";
    const compiled = new EffectCompiler().compileWorkflow(
      {
        workflow: { id: "local-repeat-workflow" },
        nodes: [
          {
            type: "repeat",
            nodeId: "repeat:1",
            input: { complete: false },
            dependsOn: [],
            maximumIterations: 2,
            body: {
              inputNodeId: "repeat:1:input",
              nodes: [
                {
                  ...localTaskNode(definition.id, repeatTaskId),
                  input: {
                    type: "ref",
                    nodeId: "repeat:1:input",
                    path: [],
                  },
                  dependsOn: ["repeat:1:input"],
                },
              ],
              output: { type: "ref", nodeId: repeatTaskId, path: [] },
              until: {
                type: "ref",
                nodeId: repeatTaskId,
                path: ["complete"],
              },
            },
          },
        ],
        output: {
          type: "ref",
          nodeId: "repeat:1",
          path: ["output"],
        },
      },
      {
        workId: "local-repeat-work",
        runId: "local-repeat-run",
        workflowInput: {},
        createInvocationId: (nodeId) => nodeId,
        executors: { agent: () => ({ execute: async () => ({}) }) },
        taskDefinitions: new Map([[definition.id, definition]]),
      },
    );

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { complete: true },
    });
  });

  it("does not call agent, model, or session infrastructure for local tasks", async () => {
    let agentCalls = 0;
    let modelCalls = 0;
    let sessionCalls = 0;
    const definition: LocalTaskDefinition = {
      id: "local-without-agent",
      input: identitySchema,
      output: identitySchema,
      execute: async () => ({ local: true }),
    };
    const compiled = compileLocal(
      localPlan(localTaskNode(definition.id)),
      definition,
      {
        executors: {
          agent: () => {
            agentCalls += 1;
            return { execute: async () => ({ unexpected: true }) };
          },
        },
        sessionResolver: {
          modelCapabilities: {
            executor: "unused",
            listModels: async () => {
              modelCalls += 1;
              return [];
            },
            resolveDefaultModel: async () => {
              modelCalls += 1;
              throw new Error("model must not be resolved");
            },
          },
          resolve: async () => {
            sessionCalls += 1;
            throw new Error("session must not be resolved");
          },
        },
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);
    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { local: true },
    });

    expect(agentCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(sessionCalls).toBe(0);
    expect(compiled.context.effectiveModelSelections).toEqual(new Map());
    expect(compiled.context.resolvedSessions).toEqual(new Map());
  });
});
