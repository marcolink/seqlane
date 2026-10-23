import { Clock, Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
// @test-scope ../../runner/profile/runtime-profile.ts
// @test-scope ../execution/abortable.ts
// @test-scope ../../classifier/system-one-client.ts
// @test-scope ../../classifier/system-one-operation.ts
// @test-scope ./task-execution.ts
// @test-scope ./effect-process.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../invocation/task-admission.ts
// @test-scope ../invocation/invocation-support.ts
// @test-scope ../compile/compile-plan.ts
// @test-scope ../execution/model-preflight.ts
// @test-scope ../session/session-preflight.ts
// @test-scope ../workspace/workspace-lock.ts
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import { join } from "node:path";
import type {
  TaskDefinition,
  Plan,
  SeqlaneEvent,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  TaskNode,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { OutputValidationError } from "../../index.js";
import {
  runCompiledWorkflow,
  startCompiledWorkflow,
} from "../execution/workflow-run.test-support.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutorResolvers } from "../execution/executor.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import { resolveCompiledWorkflowSessions } from "../session/session-preflight.js";
import type { SessionResolver } from "../session/session-resolution.js";
import { runCompiledGraphProgram } from "../execution/effect-plan.js";
import { executeAgentAdapterRequest } from "../../runner/profile/runtime-profile.js";
import type { AgentAdapter } from "@seqlane/agent-adapter";
import type { ClassifierTaskRunner } from "../../classifier/types.js";
import { SystemOneClient } from "../../classifier/system-one-client.js";
import {
  classifierRequest,
  classifierResponseBody,
} from "../../classifier/system-one-client-test-support.js";
import { LocalProcessTimeoutError } from "./effect-process.js";

const identitySchema: SeqlaneSchema = z.unknown();

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
  definition: TaskDefinition<unknown, unknown>,
  options: {
    readonly classifier?: ClassifierTaskRunner;
    readonly workspace?: string;
    readonly events?: { emit(event: SeqlaneEvent): void };
    readonly executors?: ExecutorResolvers;
    readonly sessionResolver?: SessionResolver;
    readonly taskDefinitions?: TaskDefinitionRegistry;
    readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
  } = {},
) {
  const workspace = options.workspace ?? process.cwd();
  return new PlanCompiler().compileWorkflow(plan, {
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
    classifier: options.classifier,
    onOwnedProcessAcquired: options.onOwnedProcessAcquired,
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
      const inputSchema = z.any().transform((value) => {
        expect(value).toEqual({ value: "input" });
        return { value: "parsed-input" };
      });
      const outputSchema = z.any().transform((value) => {
        expect(value).toMatchObject({
          exitCode: 0,
          stdout: `${canonicalWorkspace}\n${literalArgument}`,
          stderr: "stderr",
        });
        return { ...(value as object), parsed: true };
      });
      const definition: TaskDefinition = {
        id: "local-output",
        input: inputSchema,
        output: outputSchema,
        execute: async ({ input, context }) => {
          const result = await context.exec({
            executable: process.execPath,
            argv: [
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

  it("collects more than 512 KiB with the default output limit", async () => {
    const outputSize = 512_001;
    const definition: TaskDefinition = {
      id: "local-large-output",
      input: identitySchema,
      output: identitySchema,
      execute: async ({ context }) =>
        context.exec({
          executable: process.execPath,
          argv: ["-e", `process.stdout.write('x'.repeat(${outputSize}))`],
        }),
    };
    const compiled = compileLocal(
      localPlan(localTaskNode(definition.id)),
      definition,
    );

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "succeeded",
      result: { stdout: "x".repeat(outputSize) },
    });
  });

  it.each([0, 23])(
    "returns a %i process exit code as task output",
    async (exitCode) => {
      const definition: TaskDefinition = {
        id: `local-exit-${exitCode}`,
        input: identitySchema,
        output: identitySchema,
        execute: async ({ context }) =>
          context.exec({
            executable: process.execPath,
            argv: [
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
        result: { exitCode, stdout: "", stderr: `exit-${exitCode}` },
      });
    },
  );

  it("inherits the Plan clock across a task callback into context.exec", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-local-"));
    const controller = new AbortController();
    let acquired!: () => void;
    const registration = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let pending: ReturnType<typeof Effect.runPromise> | undefined;
    try {
      const readyPath = join(workspace, "ready");
      let timeout: unknown;
      const definition: TaskDefinition = {
        id: "local-inherited-clock",
        input: identitySchema,
        output: identitySchema,
        execute: async ({ context }) => {
          try {
            return await context.exec({
              executable: process.execPath,
              argv: [
                "-e",
                "process.stdout.write('partial', () => require('node:fs').writeFileSync(process.argv[1], String(process.pid))); setInterval(() => undefined, 1000)",
                readyPath,
              ],
              timeoutMs: 100,
            });
          } catch (cause) {
            timeout = cause;
            throw cause;
          }
        },
      };
      const compiled = compileLocal(
        localPlan(localTaskNode(definition.id)),
        definition,
        {
          workspace,
          onOwnedProcessAcquired: async () => {
            acquired();
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const nativeContext = yield* Effect.context<never>();
          const sleep = vi.spyOn(yield* Clock.Clock, "sleep");
          pending = Effect.runPromiseWith(nativeContext)(
            runCompiledGraphProgram(
              compiled,
              compiled.plan.workflow.id,
              controller.signal,
              undefined,
              0,
            ),
          );
          const pid = yield* Effect.promise(async () => {
            await registration;
            const value = Number(await waitForFile(readyPath));
            await new Promise<void>((resolve) => setImmediate(resolve));
            return value;
          });
          yield* Effect.yieldNow;
          expect(sleep).toHaveBeenCalledWith(Duration.millis(100));
          yield* TestClock.adjust(99);
          expect(timeout).toBeUndefined();
          yield* TestClock.adjust(1);
          const outcome = yield* Effect.promise(() => pending!);
          expect(outcome).toMatchObject({ status: "failed" });
          expect(timeout).toBeInstanceOf(LocalProcessTimeoutError);
          expect(timeout).toMatchObject({
            result: {
              stdout: "partial",
              stderr: "",
              stdoutTruncated: false,
              timedOut: true,
              cancelled: false,
            },
          });
          yield* Effect.promise(() => waitForProcessExit(pid));
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      controller.abort("test cleanup");
      await pending?.catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("inherits policy Clock through Plan, authored callback, agent queueing and actual adapter settlement", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queued = yield* Deferred.make<void>();
        const admission = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const aborted = yield* Deferred.make<void>();
        const settlement = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        let settled = false;
        let completed = false;
        const definition: TaskDefinition = {
          id: "inherited-agent-clock",
          input: identitySchema,
          output: identitySchema,
          execute: async ({ context }) =>
            context.runAgent({ goal: "controlled fixture", timeoutMs: 100 }),
        };
        const adapter: AgentAdapter = {
          capabilities: {
            execute: true,
            modelSelection: false,
            structuredOutput: true,
            sessionReuse: false,
            checkpoint: false,
            fork: false,
            activity: false,
            sessionUi: false,
          },
          execute: async (request) => {
            signal = request.signal;
            Deferred.doneUnsafe(queued, Effect.void);
            await Effect.runPromise(Deferred.await(admission));
            request.signal.addEventListener(
              "abort",
              () => Deferred.doneUnsafe(aborted, Effect.void),
              { once: true },
            );
            request.onExecutionStarted();
            Deferred.doneUnsafe(started, Effect.void);
            await Effect.runPromise(Deferred.await(settlement));
            settled = true;
            return "late completion";
          },
        };
        return yield* Effect.gen(function* () {
          const compiled = compileLocal(
            localPlan(localTaskNode(definition.id)),
            definition,
            {
              executors: {
                agent: () => ({
                  execute: (request) =>
                    executeAgentAdapterRequest(
                      adapter,
                      new Map([[definition.id, definition]]),
                      undefined,
                      request,
                    ),
                }),
              },
            },
          );
          const fiber = yield* runCompiledGraphProgram(
            compiled,
            compiled.plan.workflow.id,
            new AbortController().signal,
            undefined,
            0,
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(queued);
          yield* TestClock.adjust(1_000);
          expect(signal?.aborted).toBe(false);
          yield* Deferred.succeed(admission, undefined);
          yield* Deferred.await(started);
          yield* TestClock.adjust(99);
          expect(signal?.aborted).toBe(false);
          yield* TestClock.adjust(1);
          expect(signal?.aborted).toBe(true);
          yield* Deferred.await(aborted);
          expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
          expect(completed).toBe(false);
          expect(settled).toBe(false);
          yield* Deferred.succeed(settlement, undefined);
          expect(yield* Fiber.join(fiber)).toMatchObject({ status: "failed" });
          expect(settled).toBe(true);
        }).pipe(Effect.ensuring(Deferred.succeed(settlement, undefined)));
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("inherits policy Clock through Plan and authored classifier callback", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let requests = 0;
        const started = yield* Deferred.make<void>();
        const client = new SystemOneClient(
          { url: "https://localhost/v1/systemone", model: "fixture" },
          async () => {
            Deferred.doneUnsafe(started, Effect.void);
            return ++requests === 1
              ? new Response("busy", { status: 429 })
              : new Response(JSON.stringify(classifierResponseBody));
          },
        );
        const definition: TaskDefinition = {
          id: "inherited-classifier-clock",
          input: identitySchema,
          output: identitySchema,
          execute: async ({ context }) => context.classify!(classifierRequest),
        };
        const compiled = compileLocal(
          localPlan(localTaskNode(definition.id)),
          definition,
          {
            classifier: (...args) => client.classify(...args),
          },
        );
        const fiber = yield* runCompiledGraphProgram(
          compiled,
          compiled.plan.workflow.id,
          new AbortController().signal,
          undefined,
          0,
        ).pipe(Effect.forkChild);
        yield* Effect.raceFirst(
          Deferred.await(started),
          Fiber.join(fiber).pipe(
            Effect.flatMap((outcome) =>
              Effect.die(
                outcome.status === "failed"
                  ? outcome.error
                  : new Error(JSON.stringify(outcome)),
              ),
            ),
          ),
        );
        yield* TestClock.adjust(199);
        expect(requests).toBe(1);
        yield* TestClock.adjust(1);
        expect(requests).toBe(2);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          status: "succeeded",
          output: { model: "jev-1.13.0" },
        });
        expect(requests).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it("maps invalid local output to OutputValidationError and does not retain it", async () => {
    const cause = new Error("invalid output");
    const definition: TaskDefinition = {
      id: "local-invalid-output",
      input: identitySchema,
      output: z.any().transform(() => {
        throw cause;
      }),
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
      const definition: TaskDefinition = {
        id: "local-cancel",
        input: identitySchema,
        output: identitySchema,
        execute: async ({ context }) => {
          await context.exec({
            executable: process.execPath,
            argv: [
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

      const lease = await Effect.runPromise(
        compiled.context.workspaceLocks.acquireEffect(
          { key: workspace },
          "exclusive",
        ),
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
      const first: TaskDefinition = {
        id: "local-first",
        input: identitySchema,
        output: identitySchema,
        execute: async ({ context }) => {
          await context.exec({
            executable: process.execPath,
            argv: ["-e", "setTimeout(() => undefined, 100)"],
          });
          return {};
        },
      };
      const second: TaskDefinition = {
        id: "local-second",
        input: identitySchema,
        output: identitySchema,
        execute: async ({ context }) => {
          await context.exec({
            executable: process.execPath,
            argv: [
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
      const compiled = new PlanCompiler().compileWorkflow(
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

  it("does not call agent, model, or session infrastructure for local tasks", async () => {
    let agentCalls = 0;
    let modelCalls = 0;
    let sessionCalls = 0;
    const definition: TaskDefinition = {
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
