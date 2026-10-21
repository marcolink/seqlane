// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/execution/effect-plan.ts
// @test-scope ./runtime/execution/effect-repeat.ts
// @test-scope ./runtime/execution/nested-workflow.ts
// @test-scope ./runtime/validation/output-validation-effect.ts
// @test-scope ./runtime/invocation/deferred-task-completion.ts
// @test-scope ./runtime/session/session-preflight.ts
// @test-scope ./runtime/session/session-resolution.ts
// @test-scope ./runtime/session/session-lock.ts
// @test-scope ./runtime/invocation/joint-admission.ts
// @test-scope ./runtime/execution/workflow-run.ts
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineTask,
  defineValidator,
  fork,
  isolated,
  LoopLimitExceededError,
  reuse,
  type SeqlaneEvent,
  type ModelSelection,
  type ValidationResult,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startWorkflowRun } from "./start-workflow-run.js";
import { createEffectPlanProgram } from "./runtime/execution/effect-plan.js";
import type { ResolvedExecutorSession } from "./runtime/session/session-resolution.js";

function eventsForRun(events: readonly SeqlaneEvent[], runId: string) {
  return events.filter((event) => event.runId === runId);
}

describe("startWorkflowRun Effect repeat contracts", () => {
  it("transforms task input once per attempt and reuses the original input by default", async () => {
    const transformed: number[] = [];
    let attempts = 0;
    const attemptInput = z.object({
      value: z.number().transform((value) => {
        transformed.push(value);
        return value * 2;
      }),
    });
    const output = z.object({ value: z.number(), done: z.boolean() });
    const attemptTask = defineTask({
      id: "repeat-default-input-attempt",
      input: attemptInput,
      output,
      execute: async ({ input }) => {
        attempts += 1;
        return { value: input.value, done: attempts === 2 };
      },
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-default-input-workflow",
        input: z.object({ value: z.number() }),
        output,
      })
        .task("attempt", attemptTask, ({ input }) => input)
        .until(({ result }) => result.done, { maxIterations: 2 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: { value: 3 },
        identity: {
          workId: "repeat-default-work",
          runId: "repeat-default-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { value: 6, done: true },
    });
    expect(transformed).toEqual([3, 3]);
    expect(attempts).toBe(2);
    expect(
      eventsForRun(events, handle.runId).filter(
        (event) =>
          event.type === "invocation.created" && event.iteration !== undefined,
      ),
    ).toHaveLength(2);
  });

  it("repeats a child workflow with typed next input and contained unique attempts", async () => {
    let executions = 0;
    const shape = z.object({ value: z.number(), done: z.boolean() });
    const task = defineTask({
      id: "repeat-child-step",
      input: z.object({ value: z.number() }),
      output: shape,
      execute: async ({ input }) => {
        executions += 1;
        const value = input.value + 1;
        return { value, done: value >= 2 };
      },
    });
    const child = createFlow({
      id: "repeat-child-workflow",
      input: z.object({ value: z.number() }),
      output: shape,
    })
      .task("step", task, ({ input }) => input)
      .output(({ tasks }) => tasks.step.output)
      .define();
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-child-parent",
        input: z.object({ value: z.number() }),
        output: shape,
      })
        .task("child", child, ({ input }) => input)
        .until(({ result }) => result.done, {
          maxIterations: 3,
          nextInput: ({ result }) => ({ value: result.value }),
        })
        .output(({ tasks }) => tasks.child.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: { value: 0 },
        identity: { workId: "repeat-child-work", runId: "repeat-child-run" },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { value: 2, done: true },
    });
    expect(executions).toBe(2);
    const runEvents = eventsForRun(events, handle.runId);
    const attempts = runEvents.filter(
      (event) =>
        event.type === "invocation.created" &&
        event.planNodeId === "repeat:1:attempt" &&
        event.iteration !== undefined,
    );
    expect(attempts).toHaveLength(2);
    if (
      attempts[0]?.type !== "invocation.created" ||
      attempts[1]?.type !== "invocation.created"
    ) {
      throw new Error("Expected two workflow attempt creation events");
    }
    expect(attempts[0].invocationId).not.toBe(attempts[1].invocationId);
    expect(attempts[1].dependencyIds).toContain(attempts[0].invocationId);
    const childStepEvents = runEvents.filter(
      (event) => event.type === "invocation.created" && event.label === task.id,
    );
    expect(childStepEvents).toHaveLength(2);
    expect(
      childStepEvents.every(
        (event) =>
          event.type === "invocation.created" &&
          attempts.some(
            (attempt) =>
              attempt.type === "invocation.created" &&
              event.parentInvocationId === attempt.invocationId,
          ),
      ),
    ).toBe(true);
  });

  it("fails with the typed local loop limit after exactly the configured attempts", async () => {
    let executions = 0;
    const result = z.object({ done: z.boolean() });
    const task = defineTask({
      id: "repeat-limit-task",
      input: z.object({}),
      output: result,
      execute: async () => {
        executions += 1;
        return { done: false };
      },
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-limit-workflow",
        input: z.object({}),
        output: result,
      })
        .task("attempt", task, () => ({}))
        .until(({ result: attempt }) => attempt.done, { maxIterations: 3 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: { workId: "repeat-limit-work", runId: "repeat-limit-run" },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    const outcome = await handle.outcome;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed")
      throw new Error("Expected repeat limit failure");
    expect(outcome.error).toBeInstanceOf(LoopLimitExceededError);
    expect(outcome.error).toMatchObject({ maximumIterations: 3 });
    expect(executions).toBe(3);
    expect(
      eventsForRun(events, handle.runId).filter(
        (event) =>
          event.type === "invocation.created" && event.iteration !== undefined,
      ),
    ).toHaveLength(3);
  });

  it("does not start later attempts after the first body failure", async () => {
    let executions = 0;
    const output = z.object({ done: z.boolean() });
    const task = defineTask({
      id: "repeat-failing-task",
      input: z.object({}),
      output,
      execute: async () => {
        executions += 1;
        throw new Error("first repeat attempt failed");
      },
    });
    const workflow = buildWorkflow(
      createFlow({ id: "repeat-failure-workflow", input: z.object({}), output })
        .task("attempt", task, () => ({}))
        .until(({ result }) => result.done, { maxIterations: 4 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: {
          workId: "repeat-failure-work",
          runId: "repeat-failure-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    expect(await handle.outcome).toMatchObject({ status: "failed" });
    expect(executions).toBe(1);
    const attempts = eventsForRun(events, handle.runId).filter(
      (event) =>
        event.type === "invocation.created" && event.iteration !== undefined,
    );
    expect(attempts).toHaveLength(1);
  });

  it("validates each task attempt before checking the until condition", async () => {
    let executions = 0;
    let validations = 0;
    const output = z.object({ done: z.boolean() });
    const task = defineTask({
      id: "repeat-validated-task",
      input: z.object({}),
      output,
      execute: async () => {
        executions += 1;
        return { done: true };
      },
    });
    const validator = defineValidator({
      id: "repeat-reject-output",
      input: output,
      validate: () => {
        validations += 1;
        return {
          success: false as const,
          issues: [{ code: "rejected", message: "output rejected" }],
        };
      },
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-validation-workflow",
        input: z.object({}),
        output,
      })
        .task("attempt", task, () => ({}), { validateOutput: validator })
        .until(({ result }) => result.done, { maxIterations: 3 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: {
          workId: "repeat-validation-work",
          runId: "repeat-validation-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    expect(await handle.outcome).toMatchObject({ status: "failed" });
    expect(executions).toBe(1);
    expect(validations).toBe(1);
    const runEvents = eventsForRun(events, handle.runId);
    const attemptId = runEvents.find(
      (event) =>
        event.type === "invocation.created" &&
        event.planNodeId === "repeat:1:attempt" &&
        event.iteration === 1,
    );
    expect(attemptId?.type).toBe("invocation.created");
    if (attemptId?.type !== "invocation.created") {
      throw new Error("Expected repeat attempt creation");
    }
    expect(
      runEvents.filter(
        (event) =>
          event.type === "invocation.created" &&
          event.planNodeId === "repeat:1:attempt" &&
          event.iteration !== undefined,
      ),
    ).toHaveLength(1);
    expect(
      runEvents.some(
        (event) =>
          event.type === "invocation.succeeded" &&
          event.invocationId === attemptId.invocationId,
      ),
    ).toBe(false);
  });

  it("validates child workflow attempt output before stopping the repeat", async () => {
    let executions = 0;
    const task = defineTask({
      id: "repeat-workflow-output-task",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      execute: async () => {
        executions += 1;
        return { done: false };
      },
    });
    const child = createFlow({
      id: "repeat-invalid-child-output",
      input: z.object({}),
      output: z.object({ done: z.literal(true) }),
    })
      .task("attempt", task, () => ({}))
      .output(({ tasks }) => tasks.attempt.output)
      .define();
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-child-validation-parent",
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
      })
        .task("child", child, () => ({}))
        .until(({ result }) => result.done, { maxIterations: 3 })
        .output(({ tasks }) => tasks.child.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: {
          workId: "repeat-child-validation-work",
          runId: "repeat-child-validation-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    expect(await handle.outcome).toMatchObject({ status: "failed" });
    expect(executions).toBe(1);
    const runEvents = eventsForRun(events, handle.runId);
    const attempt = runEvents.find(
      (event) =>
        event.type === "invocation.created" &&
        event.planNodeId === "repeat:1:attempt",
    );
    expect(attempt?.type).toBe("invocation.created");
    if (attempt?.type !== "invocation.created")
      throw new Error("Expected child attempt creation");
    expect(
      runEvents.some(
        (event) =>
          event.type === "invocation.succeeded" &&
          event.invocationId === attempt.invocationId,
      ),
    ).toBe(false);
    expect(
      runEvents.filter(
        (event) =>
          event.type === "invocation.created" && event.iteration !== undefined,
      ),
    ).toHaveLength(1);
  });

  it("resolves an isolated agent session separately for every repeat attempt", async () => {
    const resolved: string[] = [];
    let executions = 0;
    const output = z.object({ done: z.boolean() });
    const task = defineTask({
      id: "repeat-session-task",
      input: z.object({}),
      output,
      execute: async () => {
        executions += 1;
        return { done: executions === 2 };
      },
    });
    const workflow = buildWorkflow(
      createFlow({ id: "repeat-session-workflow", input: z.object({}), output })
        .task("attempt", task, () => ({}), { session: isolated() })
        .until(({ result }) => result.done, { maxIterations: 2 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: {
          workId: "repeat-session-work",
          runId: "repeat-session-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      {
        program: (context) =>
          createEffectPlanProgram({
            ...context,
            resolveExecution: async (signal) => {
              const execution = await context.resolveExecution(signal);
              return {
                ...execution,
                sessionResolver: {
                  resolve: async ({ invocationId }) => {
                    resolved.push(invocationId);
                    return {
                      key: Symbol(invocationId),
                      executor: { execute: async () => ({}) },
                    };
                  },
                },
              };
            },
          }),
      },
    );

    await expect(handle.outcome).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(executions).toBe(2);
    expect(resolved).toHaveLength(2);
    expect(new Set(resolved).size).toBe(2);
    const attemptIds = eventsForRun(events, handle.runId)
      .filter(
        (event) =>
          event.type === "invocation.created" &&
          event.planNodeId === "repeat:1:attempt" &&
          event.iteration !== undefined,
      )
      .map((event) =>
        event.type === "invocation.created" ? event.invocationId : "",
      );
    expect(resolved).toEqual(attemptIds);
  });

  it.each(["reuse", "fork"] as const)(
    "resolves repeated %s attempts from one completed source session",
    async (policy) => {
      const sourceCheckpoint = { revision: "source-revision-1" };
      const sessionResolutions: string[] = [];
      const forkRequests: Array<{
        readonly invocationId: string;
        readonly checkpoint: unknown;
        readonly effectiveSelection?: ModelSelection;
      }> = [];
      const sessionUses: Array<{ session: string; taskId: string }> = [];
      let checkpointCaptures = 0;
      let attemptExecutions = 0;
      const sourceTask = defineAgentTask({
        id: "repeat-session-source-task",
        input: z.object({}),
        output: z.object({ ready: z.boolean() }),
        goal: () => "Prepare the repeat session.",
      });
      const attemptTask = defineAgentTask({
        id: `repeat-session-${policy}-task`,
        input: z.object({ ready: z.boolean() }),
        output: z.object({ done: z.boolean() }),
        goal: () => "Complete a repeat attempt.",
      });
      const resultSchema = z.object({ done: z.boolean() });
      const workflow = buildWorkflow(
        createFlow({
          id: `repeat-session-${policy}-workflow`,
          input: z.object({}),
          output: resultSchema,
        })
          .task("source", sourceTask, () => ({}), {
            session: isolated(),
          })
          .task("attempt", attemptTask, () => ({ ready: true }), {
            session: ({ tasks }) =>
              policy === "reuse"
                ? reuse(tasks.source.session)
                : fork(tasks.source.session),
          })
          .until(({ result }) => result.done, { maxIterations: 2 })
          .output(({ tasks }) => tasks.attempt.output)
          .define(),
      );
      const events: SeqlaneEvent[] = [];
      const sourceSession: ResolvedExecutorSession = {
        key: Symbol("repeat-session-source"),
        effectiveSelection: {
          model: { provider: "openai", model: "gpt-5.6-sol" },
          reasoning: "medium",
        },
        executor: {
          execute: async ({ taskId }) => {
            sessionUses.push({ session: "source", taskId });
            if (taskId === sourceTask.id) return { ready: true };
            attemptExecutions += 1;
            return { done: attemptExecutions === 2 };
          },
        },
        checkpoint: async () => {
          checkpointCaptures += 1;
          return sourceCheckpoint;
        },
        fork: async (request) => {
          forkRequests.push(request);
          const session = `fork-${forkRequests.length}`;
          return {
            key: Symbol(request.invocationId),
            effectiveSelection: request.effectiveSelection,
            executor: {
              execute: async ({ taskId }) => {
                sessionUses.push({ session, taskId });
                attemptExecutions += 1;
                return { done: attemptExecutions === 2 };
              },
            },
          };
        },
      };
      const handle = startWorkflowRun(
        {
          workflow,
          input: {},
          identity: {
            workId: `repeat-session-${policy}-work`,
            runId: `repeat-session-${policy}-run`,
          },
          events: { emit: (event) => events.push(event) },
        },
        {
          program: (context) =>
            createEffectPlanProgram({
              ...context,
              resolveExecution: async (signal) => {
                const execution = await context.resolveExecution(signal);
                return {
                  ...execution,
                  sessionResolver: {
                    resolve: async ({ invocationId }) => {
                      sessionResolutions.push(invocationId);
                      return sourceSession;
                    },
                  },
                };
              },
            }),
        },
      );

      await expect(handle.outcome).resolves.toMatchObject({
        status: "succeeded",
        result: { done: true },
      });
      expect(attemptExecutions).toBe(2);
      expect(sessionResolutions).toHaveLength(1);
      const runEvents = eventsForRun(events, handle.runId);
      const sourceCreated = runEvents.find(
        (event) =>
          event.type === "invocation.created" &&
          event.subject.type === "task" &&
          event.subject.taskId === sourceTask.id,
      );
      if (sourceCreated?.type !== "invocation.created") {
        throw new Error("Expected source invocation creation");
      }
      const sourceSucceededIndex = runEvents.findIndex(
        (event) =>
          event.type === "invocation.succeeded" &&
          sourceCreated?.type === "invocation.created" &&
          event.invocationId === sourceCreated.invocationId,
      );
      const attemptCreatedIndex = runEvents.findIndex(
        (event) =>
          event.type === "invocation.created" &&
          event.planNodeId === "repeat:1:attempt" &&
          event.iteration === 1,
      );
      expect(sourceSucceededIndex).toBeGreaterThanOrEqual(0);
      expect(attemptCreatedIndex).toBeGreaterThan(sourceSucceededIndex);

      const attemptIds = runEvents
        .filter(
          (event) =>
            event.type === "invocation.created" &&
            event.planNodeId === "repeat:1:attempt" &&
            event.iteration !== undefined,
        )
        .map((event) =>
          event.type === "invocation.created" ? event.invocationId : "",
        );
      expect(attemptIds).toHaveLength(2);
      const attempts = runEvents.filter(
        (event) =>
          event.type === "invocation.created" &&
          event.planNodeId === "repeat:1:attempt" &&
          event.iteration !== undefined,
      );
      if (
        attempts.length !== 2 ||
        attempts[0]?.type !== "invocation.created" ||
        attempts[1]?.type !== "invocation.created"
      ) {
        throw new Error("Expected two repeated attempt invocations");
      }
      expect(attempts[0].dependencyIds).toContain(sourceCreated.invocationId);
      expect(attempts[1].dependencyIds).toContain(sourceCreated.invocationId);
      expect(attempts[1].dependencyIds).toContain(attempts[0].invocationId);
      if (policy === "reuse") {
        expect(checkpointCaptures).toBe(0);
        expect(forkRequests).toHaveLength(0);
        expect(
          sessionUses
            .filter(({ taskId }) => taskId === attemptTask.id)
            .map(({ session }) => session),
        ).toEqual(["source", "source"]);
      } else {
        expect(checkpointCaptures).toBe(1);
        expect(forkRequests.map(({ invocationId }) => invocationId)).toEqual(
          attemptIds,
        );
        expect(
          forkRequests.every(
            ({ checkpoint }) => checkpoint === sourceCheckpoint,
          ),
        ).toBe(true);
        expect(
          new Set(forkRequests.map(({ invocationId }) => invocationId)).size,
        ).toBe(2);
        expect(
          forkRequests.map(({ effectiveSelection }) => effectiveSelection),
        ).toEqual([
          {
            model: { provider: "openai", model: "gpt-5.6-sol" },
            reasoning: "medium",
          },
          {
            model: { provider: "openai", model: "gpt-5.6-sol" },
            reasoning: "medium",
          },
        ]);
        expect(
          sessionUses
            .filter(({ taskId }) => taskId === attemptTask.id)
            .map(({ session }) => session),
        ).toEqual(["fork-1", "fork-2"]);
      }
    },
  );

  it("rejects a malformed task-based validation result before its gate starts", async () => {
    const taskOutput = z.object({ done: z.boolean() });
    const attempt = defineTask({
      id: "repeat-malformed-check-attempt",
      input: z.object({}),
      output: taskOutput,
      execute: async () => ({ done: true }),
    });
    const check = defineTask({
      id: "repeat-malformed-check",
      input: taskOutput,
      output: z.custom<ValidationResult>(() => false),
      execute: async (): Promise<ValidationResult> => ({ success: true }),
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "repeat-malformed-check-workflow",
        input: z.object({}),
        output: taskOutput,
      })
        .task("attempt", attempt, () => ({}), { validateOutput: check })
        .until(({ result }) => result.done, { maxIterations: 1 })
        .output(({ tasks }) => tasks.attempt.output)
        .define(),
    );
    const events: SeqlaneEvent[] = [];
    const handle = startWorkflowRun(
      {
        workflow,
        input: {},
        identity: {
          workId: "repeat-malformed-work",
          runId: "repeat-malformed-run",
        },
        events: { emit: (event) => events.push(event) },
      },
      { program: createEffectPlanProgram },
    );

    expect(await handle.outcome).toMatchObject({ status: "failed" });
    const runEvents = eventsForRun(events, handle.runId);
    const checkCreated = runEvents.find(
      (event) =>
        event.type === "invocation.created" &&
        event.subject.type === "task" &&
        event.subject.taskId === check.id,
    );
    expect(checkCreated?.type).toBe("invocation.created");
    if (checkCreated?.type !== "invocation.created")
      throw new Error("Expected validation check creation");
    expect(runEvents).toContainEqual(
      expect.objectContaining({
        type: "invocation.skipped",
        invocationId: `${checkCreated.invocationId.replace(":validation:check", ":validation:gate")}`,
        reason: "Validation check failed before gate execution",
      }),
    );
    expect(
      runEvents.some(
        (event) =>
          event.type === "invocation.started" &&
          event.invocationId.endsWith(":validation:gate"),
      ),
    ).toBe(false);
  });
});
